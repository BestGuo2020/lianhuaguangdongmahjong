// 「莲花麻将」本地引擎组装：把规则/开局/回合/杠/结算/人类/AI 拼成 GamePort。
// 结构仿 core/local/useGame.ts，但整体独立于「莲花广麻」，复用共享的计时/瞬态事件/音效模块。
import { computed, getCurrentInstance, onBeforeUnmount, ref, watch } from 'vue'
import type { TableActionEvent, TileType } from '../../core/contracts/types'
import { defineGamePort } from '../../core/contracts/gamePort'
import type { ReplayFrameSource, ReplayRecorderHooks } from '../../replay/types'
import type { AnalysisRecorder } from '../../replay/analysis/recorder'
import type { LotusActionLike, LotusDecisionMethod, LotusSeatObservable, LotusWindowDescriptor } from '../../replay/analysis/lotusLegacyAdapter'
import {
  choiceTookEffect,
  chosenIndex,
  decisionStateOf,
  decisionWindowOf,
  legalActionId,
  lotusSeatView,
  observableOf,
  roundIdOf,
  settlementsFromRound,
  toLotusActionLike,
  windowIdOf,
  windowKindOfMethod,
} from '../../replay/analysis/lotusLegacyAdapter'
import { createLocalCountdownController } from '../../core/local/localCountdownController'
import { createLocalTransientEventPresenter } from '../../core/local/localTransientEventPresenter'
import { createMatchLifecycle } from '../../shared/runtime/matchLifecycle'
import { createTimerScheduler } from '../../shared/runtime/timerScheduler'
import type { PlayerSeed } from '../../shared/runtime/localOpening'
import { resolveAnimeAudioPolicy } from '../../core/presentation/animeAudioPolicy'
import {
  ANIME_ACTION_FALLBACK_AUDIO,
  type AnimeFixedTtsExecutor,
  type AnimeSeat,
} from '../../llm/animeFixedTtsExecutor'

const ANIME_FIXED_ACTION_AUDIO_FILES: ReadonlySet<string> = new Set(
  Object.values(ANIME_ACTION_FALLBACK_AUDIO),
)
import { tileName } from '../../core/rules/tiles'
import type { LotusController, LotusHumanBridge } from './lotusControllers'
import { LotusAiController, LotusHumanController } from './lotusControllers'
import { createLotusHuman } from './lotusHuman'
import { createLotusKong } from './lotusKong'
import { sortTilesWithJokers } from '../../core/rules/tiles'
import { createLotusOpening } from './lotusOpening'
import { createLotusSelectors } from './lotusSelectors'
import { createLotusSettlement } from './lotusSettlement'
import { structuralMeldCount } from './lotusSelectors'
import { createLotusGameState, type LotusEndGameOptions } from './lotusState'
import { createLotusTileFlow } from './lotusTileFlow'
import { createLotusTurnOrchestrator } from './lotusTurnOrchestrator'
import { LOTUS_RULESET } from './lotusRules'
import type { RuleSet } from '../../core/rules/ruleset'
import { createFollowDealerTracker } from '../../shared/runtime/followDealer'

interface UseLotusGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  controllers?: LotusController[]
  /** 单机人机：注入座位 1-3 的 AI 控制器（可含 LLM 控制器）；默认启发式 AI 玩家 */
  aiControllers?: LotusController[]
  /** 单机人机：座位 1-3 的玩家形象（昵称/头像，LLM 人设覆盖） */
  aiPlayerSeeds?: Array<PlayerSeed | undefined>
  /** 单机本家座位 0 的展示形象。 */
  humanPlayerSeed?: PlayerSeed
  /** 由表现层动态读取；规则引擎不得直接访问 DOM 或 URL。 */
  getThemeName?: () => string
  animeFixedTts?: AnimeFixedTtsExecutor
  countdownEnabled?: boolean
  ruleset?: RuleSet
  /** 对局回放录制钩子（可选；不传时零行为变化）。 */
  recorder?: ReplayRecorderHooks
  /**
   * AI 分析记录（可选；约定见 docs/blood-flow/design/analysis-two-variants-work-agreement.md）。
   * 拿到的是一个**稳定代理**：换场只换内部录制器，关闭时所有写入空转（§9.2）。
   * 不传时零成本、零行为变化 —— 记录层只旁路观测，不参与决策（§10.1）。
   */
  analysis?: AnalysisRecorder | null
}

export function useLotusGame({
  playSound = () => {},
  playSoundAndWait = async () => {},
  controllers: suppliedControllers,
  aiControllers,
  aiPlayerSeeds,
  humanPlayerSeed,
  getThemeName = () => 'jade',
  animeFixedTts,
  countdownEnabled = true,
  ruleset = LOTUS_RULESET,
  recorder,
  analysis,
}: UseLotusGameOptions = {}) {
  const state = createLotusGameState()
  const selectors = createLotusSelectors(state, ruleset)

  // ── 对局回放录制 ──
  // 比广麻多带翻精结果（指示牌/精牌/替身/断点），回放才能还原牌山与牌面标记。
  const replayFrame = (): ReplayFrameSource => ({
    players: state.players,
    wallLeft: state.wall.value.length,
    headDrawn: state.wallHeadDrawn.value,
    currentPlayer: state.currentPlayer.value,
    round: state.round.value,
    dealer: state.dealer.value,
    honba: state.honba.value,
    matchType: state.matchType.value,
    diceValues: [...state.diceValues.value],
    firstDice: state.firstDice.value ? [...state.firstDice.value] : undefined,
    diceThrowerIndex: state.diceThrowerIndex.value,
    wallBreakIndex: state.wallBreakIndex.value,
    flipTile: state.flipTile.value,
    jokerTiles: [...state.jokerTiles.value],
    wildcardTiles: [...state.wildcardTiles.value],
    flipStack: state.flipStack.value,
  })

  let openingTimeline!: ReturnType<typeof createLotusOpening>
  let settlementTimeline!: ReturnType<typeof createLotusSettlement>
  let kong!: ReturnType<typeof createLotusKong>
  let turnOrchestrator!: ReturnType<typeof createLotusTurnOrchestrator>
  let tileFlowExecutor!: ReturnType<typeof createLotusTileFlow>
  let playerActions!: ReturnType<typeof createLotusHuman>
  let countdown!: ReturnType<typeof createLocalCountdownController>
  let transient!: ReturnType<typeof createLocalTransientEventPresenter>

  const usesAnimeFixedActionVoice = () => resolveAnimeAudioPolicy({
    themeName: getThemeName(),
    playerKind: 'unknown',
  }).actionVoice === 'fixed-line'
  const playPresentationSound = (name: string, volume?: number, onFinish?: () => void) => {
    if (usesAnimeFixedActionVoice() && ANIME_FIXED_ACTION_AUDIO_FILES.has(name)) return
    if (onFinish !== undefined) return playSound(name, volume, onFinish)
    if (volume !== undefined) return playSound(name, volume)
    return playSound(name)
  }
  const playPresentationSoundAndWait = (name: string, volume?: number) => (
    usesAnimeFixedActionVoice() && ANIME_FIXED_ACTION_AUDIO_FILES.has(name)
      ? Promise.resolve()
      : playSoundAndWait(name, volume)
  )
  const playAnimeAction = (event: TableActionEvent) => {
    if (!animeFixedTts || !usesAnimeFixedActionVoice()) return
    const actor = state.players[event.actorIndex]
    if (!actor || event.actorIndex < 0 || event.actorIndex > 3) return
    void animeFixedTts.executeAction({
      eventId: event.id,
      seat: event.actorIndex as AnimeSeat,
      characterId: actor.characterId,
      action: event.type,
    }).then((result) => {
      if (result.fallbackAudioFile) playSound(result.fallbackAudioFile)
    }).catch(() => {})
  }

  const humanBridge: LotusHumanBridge = {
    isTurn: ref(false),
    canHu: ref(false),
    canKong: ref<TileType[]>([]),
    canWindKong: ref(false),
    actionPrompt: state.actionPrompt,
    selectedIndex: state.selectedIndex,
    drawnThisTurn: state.userDrewThisTurn,
    turnSeconds: state.turnSeconds,
    activateTurn() {
      state.phase.value = 'discard'
      countdown.startTurn()
    },
    activateHu() {
      state.phase.value = 'prompt'
      countdown.startPrompt()
    },
    activateClaim() {
      state.phase.value = 'prompt'
      countdown.startPrompt()
    },
    activateChi() {
      state.phase.value = 'prompt'
      countdown.startPrompt()
    },
    activateRobKong() {
      state.phase.value = 'prompt'
      transient.announce('可抢杠胡', 'red')
      countdown.startPrompt()
    },
    deactivate() {
      countdown?.stop()
    },
  }
  const humanController = new LotusHumanController(humanBridge)
  // 复制一份：分析录制会把控制器换成观测包装，绝不能写穿调用方传进来的数组。
  const controllers: LotusController[] = suppliedControllers ? [...suppliedControllers] : [
    humanController,
    ...(aiControllers && aiControllers.length ? aiControllers : [new LotusAiController(), new LotusAiController(), new LotusAiController()]),
  ]

  // ── AI 分析记录（§3.2／§3.3／§3.4） ────────────────────────────────
  //
  // 翻精癞子没有权威窗口对象：决策窗口由**编排层调用控制器**产生。因此记录点就包在控制器外面 ——
  // 编排层的五个询问入口（回合／胡／碰杠／吃／抢杠）正好就是全部决策窗口，一处都不用漏，也不必
  // 去改编排层。包装是纯观测：候选、来源、回执都只读，不参与决策、不改对局行为（§10.1）。
  //
  // 窗口 ID 用**本局内的决策计数**（§3.1：可离线复算，不用时间戳/帧号）。计数器只在真的记下
  // 一个窗口时自增，因此编号是连续的、能在记录侧复算出来。
  let analysisWindowCounter = 0
  /**
   * 本局在整场里的序号（1 起），每局开局加一 —— **不能用 `state.round`**：连庄时它不变、只加
   * `honba`，两局会共用同一个 roundId，窗口 ID 跟着重复，录制器按 `windowId#seat` 建决策对象
   * 就会把第二局的决策写进第一局那条记录里。展示回放用的是同一套口径（"已打局数 + 1"），
   * 两边对齐后 §9.3 的"按 roundIndex 配对"才对得上。
   */
  let analysisRoundSequence = 0
  /** 已开窗但还没收到执行回执的窗口（下一个窗口开启时结算，§3.4）。 */
  const analysisOpenWindow = new Map<number, {
    windowId: string
    seat: number
    before: LotusSeatObservable
    action: LotusActionLike | null
  }>()
  /** 本局开局分数（结算折算的基准，§5）；在开局阶段捕获，与传给引擎的开局读数同一时刻。 */
  let analysisOpeningScores: number[] = []
  /** 已经折算过结算的那一份 `state.result`（同一局不得重复记：对象身份即"这一次结算"）。 */
  let analysisSettledResult: unknown = null
  /** 已包过观测的控制器实例：重复安装不得把包装再包一层。 */
  const analysisWrapped = new WeakSet<LotusController>()

  /** 牌桌快照：投影的输入（别家手牌在 `lotusSeatView` 里被遮蔽）。 */
  const analysisTableSnapshot = () => ({
    players: state.players.map((player) => ({
      hand: player.hand,
      melds: player.melds,
      discards: player.discards,
      drawnTileIndex: player.drawnTileIndex,
      score: player.score,
    })),
    jokers: state.jokerTiles.value,
    wildcardTiles: state.wildcardTiles.value,
  })

  /**
   * 记录代码的**唯一**执行口：任何记录侧异常都只吞掉并留痕。
   * §10.2／§9.5：分析落库失败最多让这一场不完整，绝不能把异常抛回对局路径。
   */
  function safely<T>(what: string, run: () => T): T | null {
    try {
      return run()
    } catch (error) {
      try {
        analysis?.noteGap({
          scope: 'recorder',
          reason: `${what}-failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      } catch { /* 留痕自身失败也要吞掉（§9.5 独立失败域） */ }
      return null
    }
  }

  /** 结算某个已开窗的执行回执：只认该座位自己的可见变化（§3.4、§10.2）。 */
  function settleAnalysisReceipt(seat: number, detail: string) {
    const open = analysisOpenWindow.get(seat)
    if (!open) return
    analysisOpenWindow.delete(seat)
    const action = open.action
    if (!action) return
    safely('receipt', () => {
      const after = observableOf(analysisTableSnapshot(), seat)
      analysis?.receipt({
        windowId: open.windowId,
        seat,
        status: choiceTookEffect(open.before, after, action) ? 'executed' : 'state-changed',
        detail,
      })
    })
  }

  /**
   * 把**所有**还挂着的回执一次结掉。
   *
   * 在"下一个窗口开启时"调用（而不是等同一个座位的下一个窗口）：编排层是**串行**的 ——
   * 它 `await` 完一个座位的控制器、把动作应用掉，才会去问下一个座位。所以任何一个新窗口
   * 开启时，此前所有窗口的动作都已经落定，此刻的可见变化是最贴近"这一手"的读数；
   * 等同一个座位的下一个窗口会跨越好几手，把别人的动作也算进来（误判成 executed）。
   */
  function settleOpenReceipts(detail: string) {
    for (const seat of [...analysisOpenWindow.keys()]) settleAnalysisReceipt(seat, detail)
  }

  /**
   * 记一个决策窗口：开窗（含前态与合法动作）→ 等控制器作出选择 → 记选择与来源。
   * 来源按**控制器类型**如实标注：人类 = `human`，本地启发式 AI = `rule-auto`，
   * 其余（LLM 控制器）= `unknown` —— 本阶段没接模型钩子，不猜它到底是模型还是回退（§3.4、§9）。
   *
   * 注意这个函数**恒为 async 且恒 await 一次**（无论记不记录）：记录开/关两条路径的
   * 微任务时序因此完全一样，"记录不得影响对局"这条硬护栏就不会被"少一个 tick"的差异污染。
   */
  async function recordAnalysisWindow<T>(
    seat: number,
    method: LotusDecisionMethod,
    raw: LotusController,
    run: () => Promise<T>,
    window: { tile?: TileType; from?: number; skipDraw?: boolean; kongBloom?: boolean } = {},
  ): Promise<T> {
    const recorder = analysis
    const view = recorder
      ? safely('window-open', () => {
        // 开新窗口 ⇒ 此前所有窗口的动作都已应用，先把它们的回执结掉。
        settleOpenReceipts('window-advanced')
        const roundId = roundIdOf(analysisRoundSequence)
        const windowId = windowIdOf(roundId, analysisWindowCounter + 1)
        const kind = windowKindOfMethod(method)
        const descriptor: LotusWindowDescriptor = {
          windowId, roundId, kind, seat,
          ...(window.tile !== undefined ? { tile: window.tile } : {}),
          ...(window.from !== undefined ? { from: window.from } : {}),
          ...(window.skipDraw !== undefined ? { skipDraw: window.skipDraw } : {}),
          ...(window.kongBloom !== undefined ? { kongBloom: window.kongBloom } : {}),
        }
        const seatView = lotusSeatView(analysisTableSnapshot(), descriptor, ruleset)
        // 该座位此刻没有可选动作 ⇒ 不是决策窗口，照常放行、不占编号。
        if (!decisionWindowOf(seatView)) return null
        recorder.windowOpened({
          windowId, seat, windowKind: kind,
          roundIndex: analysisRoundSequence,
          authorityEpoch: 'local',
          stateVersion: analysisWindowCounter + 1,
          state: decisionStateOf(seatView),
        })
        analysisWindowCounter += 1
        return seatView
      })
      : null
    const before = view ? observableOf(analysisTableSnapshot(), seat) : null
    const action = await run()
    if (recorder && view && before) {
      safely('chosen', () => {
        const picked = toLotusActionLike(action)
        const index = chosenIndex(view, picked)
        recorder.chosen({
          windowId: view.windowId, seat,
          source: raw instanceof LotusHumanController ? 'human' : raw instanceof LotusAiController ? 'rule-auto' : 'unknown',
          legalActionId: index >= 0 ? legalActionId(view.windowId, index) : null,
        })
        analysisOpenWindow.set(seat, { windowId: view.windowId, seat, before, action: picked })
      })
    }
    return action
  }

  /** 把一个控制器包装成观测版；除记录外行为完全一致（含 reset/onDiscarded 转发）。 */
  function wrapAnalysisController(controller: LotusController, seat: number): LotusController {
    if (analysisWrapped.has(controller)) return controller
    const wrapped: LotusController = {
      requestTurn: (ctx) => recordAnalysisWindow(seat, 'requestTurn', controller, () => controller.requestTurn(ctx), {
        skipDraw: ctx.skipDraw, kongBloom: ctx.kongBloom,
      }),
      requestDiscardHu: (ctx) => recordAnalysisWindow(seat, 'requestDiscardHu', controller, () => controller.requestDiscardHu(ctx), {
        tile: ctx.tile, from: ctx.from,
      }),
      requestClaim: (ctx) => recordAnalysisWindow(seat, 'requestClaim', controller, () => controller.requestClaim(ctx), {
        tile: ctx.tile, from: ctx.from,
      }),
      requestChi: (ctx) => recordAnalysisWindow(seat, 'requestChi', controller, () => controller.requestChi(ctx), {
        tile: ctx.tile, from: ctx.from,
      }),
      requestRobKong: (ctx) => recordAnalysisWindow(seat, 'requestRobKong', controller, () => controller.requestRobKong(ctx), {
        tile: ctx.tile, from: ctx.from,
      }),
      onDiscarded: () => controller.onDiscarded?.(),
      reset: () => controller.reset?.(),
    }
    analysisWrapped.add(controller)
    analysisWrapped.add(wrapped)
    return wrapped
  }

  /**
   * 就地安装观测包装。必须在编排器/动作控制器创建**之前**跑：它们按引用捕获这个数组。
   * `replaceAiControllers` 之后要再跑一次（设置页换 AI 会换掉座位 1-3 的实例）。
   */
  function installAnalysisWrappers() {
    if (!analysis) return
    for (let seat = 0; seat < controllers.length; seat += 1) {
      const controller = controllers[seat]
      if (controller) controllers[seat] = wrapAnalysisController(controller, seat)
    }
  }
  installAnalysisWrappers()

  // 设置页只在大厅开放；保存后替换内部数组，使下一次开局读取新的 AI 控制器。
  // 调用方不能直接替换 aiControllers 参数，因为下游编排器持有的是这个数组的引用。
  function replaceAiControllers(nextControllers?: LotusController[] | null) {
    const replacement = nextControllers && nextControllers.length
      ? nextControllers
      : [new LotusAiController(), new LotusAiController(), new LotusAiController()]
    controllers.splice(1, Math.max(0, controllers.length - 1), ...replacement)
    // 新实例还没被观测包装过：不重装的话这一局之后座位 1-3 就不再产生决策记录。
    installAnalysisWrappers()
  }

  const timer = createTimerScheduler({
    controllers,
    stopCountdown: () => countdown?.stop(),
    cancelOpening: () => openingTimeline?.cancel(),
  })
  const clearPresentation = () => {
    timer.clear()
    animeFixedTts?.cancel()
  }
  transient = createLocalTransientEventPresenter({
    state,
    later: timer.later,
    onTableAction: playAnimeAction,
  })
  if (recorder) {
    // 碰/吃/杠/胡的唯一统一出口（含莲花麻将的风杠与吃）。
    const baseShowTableAction = transient.showTableAction
    transient.showTableAction = (type, actorIndex, sourceIndex, tile, meldIndex) => {
      baseShowTableAction(type, actorIndex, sourceIndex, tile, meldIndex)
      recorder.tableAction({ type, actorIndex, sourceIndex, tile, meldIndex }, replayFrame())
    }
  }

  // 跟庄：开局第一圈，庄家首弃后三闲家各出一张同牌 → 庄家向三家各付底分。
  const followDealer = createFollowDealerTracker({
    players: state.players,
    dealerIndex: () => state.dealer.value,
    baseScore: ruleset.baseScore,
    onTrigger: (deltas) => {
      transient.showScoreFlow(deltas)
      transient.announce('跟庄')
    },
  })

  function endGame(winnerIndex: number, options: LotusEndGameOptions = {}) {
    return settlementTimeline.endGame(winnerIndex, options)
  }

  function endDraw() {
    return settlementTimeline.endDraw()
  }

  function beginTurn(playerIndex: number, options: { skipDraw?: boolean; fromTail?: boolean } = {}) {
    return turnOrchestrator.beginTurn(playerIndex, options)
  }

  settlementTimeline = createLotusSettlement({
    state,
    clearTimers: clearPresentation,
    later: timer.later,
    playSound: playPresentationSound,
    playSoundAndWait: playPresentationSoundAndWait,
    showTableAction: transient.showTableAction,
    structuralMeldCount: (playerIndex) => structuralMeldCount(state.players[playerIndex]),
    getRoundLabel: () => selectors.roundLabel.value,
    ruleset,
    getThemeName,
    animeFixedTts,
  })

  countdown = createLocalCountdownController({
    state,
    playSound: playPresentationSound,
    enabled: countdownEnabled,
    onDiscard: () => playerActions.userDiscard(),
    onPass: () => playerActions.userPass(),
  })

  tileFlowExecutor = createLotusTileFlow({
    state,
    controllers,
    getTurnOrchestrator: () => turnOrchestrator,
    endDraw,
    playSound: playPresentationSound,
    playSoundAndWait: playPresentationSoundAndWait,
    shouldAnnounceDiscard: (_playerIndex, player) => (
      resolveAnimeAudioPolicy({
        themeName: getThemeName(),
        playerKind: player.playerKind,
        isLlm: player.isLlm,
      }).discard.tileName !== 'suppress'
    ),
    later: timer.later,
    stopCountdown: countdown.stop,
    followDealer,
  })
  if (recorder) {
    // 必须在创建编排器/动作控制器之前包装：它们按引用捕获这两个函数。
    const baseDrawFor = tileFlowExecutor.drawFor
    tileFlowExecutor.drawFor = async (playerIndex: number, fromTail = false) => {
      const drawn = await baseDrawFor(playerIndex, fromTail)
      if (drawn) {
        const player = state.players[playerIndex]
        const tile = player?.hand[player.drawnTileIndex] ?? player?.hand[player.hand.length - 1]
        if (tile) recorder.draw({ seat: playerIndex, tile, fromTail }, replayFrame())
      }
      return drawn
    }
    const baseDiscardTile = tileFlowExecutor.discardTile
    tileFlowExecutor.discardTile = (playerIndex: number, requestedIndex: number) => {
      const before = state.players[playerIndex]?.discards.length ?? 0
      baseDiscardTile(playerIndex, requestedIndex)
      const player = state.players[playerIndex]
      const tile = player && player.discards.length > before ? player.discards[player.discards.length - 1] : null
      if (!tile) return
      const last = state.lastDiscard.value
      recorder.discard({
        seat: playerIndex,
        tile,
        id: last && last.from === playerIndex ? last.id : Date.now(),
      }, replayFrame())
    }
  }

  openingTimeline = createLotusOpening({
    state,
    clearTimers: clearPresentation,
    takeTile: tileFlowExecutor.takeTile,
    wait: timer.wait,
    later: timer.later,
    playSound: playPresentationSound,
    playSoundAndWait: playPresentationSoundAndWait,
    announce: transient.announce,
    getRoundLabel: () => selectors.roundLabel.value,
    beginTurn,
    ruleset,
    endGame,
    playerSeeds: aiPlayerSeeds,
    humanPlayerSeed,
  })
  // 每局开局先复位跟庄窗口，再走开局时间线。
  const startGame = (
    mode?: Parameters<typeof openingTimeline.start>[0],
    startOptions?: Parameters<typeof openingTimeline.start>[1],
  ) => {
    animeFixedTts?.reset()
    followDealer.reset()
    // 传了 mode 就是**新的一场**（nextRound 走的是不带 mode 的那条路）：本局序号与结算去重都要
    // 从头开始，否则第二场的 roundId 会接着上一场继续涨、与展示回放的"已打局数"对不上。
    if (mode) {
      analysisRoundSequence = 0
      analysisSettledResult = null
    }
    // 转交开局参数（固定牌墙/骰子）。此前第二个参数被丢掉 ⇒ 只有本引擎做不到"同一副牌重跑两次"，
    // 而"记录开/关两种设置下结束分数与动作数完全一致"这条硬护栏正需要它（§9）。
    // 现有调用方都只传一个参数，因此行为不变。
    return openingTimeline.start(mode, startOptions)
  }

  const tableContext = {
    players: state.players,
    currentPlayer: state.currentPlayer,
    sortHand: (hand) => sortTilesWithJokers(hand, state.jokerTiles.value),
    showTableAction: transient.showTableAction,
    showScoreFlow: transient.showScoreFlow,
    playSound: playPresentationSound,
  }

  kong = createLotusKong({
    state,
    showTableAction: transient.showTableAction,
    showScoreFlow: transient.showScoreFlow,
    playSound: playPresentationSound,
    later: timer.later,
    ruleset,
    beginTurn,
  })
  turnOrchestrator = createLotusTurnOrchestrator({
    state,
    controllers,
    tableContext,
    structuralMeldCount: (playerIndex) => structuralMeldCount(state.players[playerIndex]),
    drawFor: tileFlowExecutor.drawFor,
    performConcealedKong: kong.performConcealedKong,
    performWindKong: kong.performWindKong,
    declareAddedKong: kong.declareAddedKong,
    settleAddedKong: kong.settleAddedKong,
    discardTile: tileFlowExecutor.discardTile,
    endDraw,
    endGame,
    announce: transient.announce,
    later: timer.later,
    ruleset,
    followDealer,
  })

  playerActions = createLotusHuman({
    state,
    humanController,
    tableContext,
    turnOrchestrator,
    kong,
    getUser: () => selectors.user.value,
    isUserTurn: () => selectors.isUserTurn.value,
    canUserHu: () => selectors.userCanHu.value,
    getUserKongs: () => selectors.userKongs.value,
    userHasWindKong: () => selectors.userHasWindKong.value,
    stopCountdown: countdown.stop,
    startTurnCountdown: countdown.startTurn,
    discardTile: tileFlowExecutor.discardTile,
    beginTurn: (playerIndex, options) => beginTurn(playerIndex, options),
    endGame,
    announce: transient.announce,
    playSound: playPresentationSound,
    later: timer.later,
  })

  const matchLifecycle = createMatchLifecycle({ state, clearTimers: clearPresentation, startGame })
  /**
   * 中途退出（整场没打完）：把已经录到的分析数据刷进分析区并如实标成不完整（§9.5：不许静默丢），
   * 同时结束本场会话 —— 否则会话一直是 active，App 的 `analysis.active()` 守卫会跳过下一场
   * 的 `start()`，新对局的记录会挂到上一场的 matchId 上（错场归属，实测隐患）。
   * 正常打完时 `matchFinished` 已为真：那条路径上 App 已经 finish 过一次，这里不再重复留痕。
   */
  const returnToLobby = () => {
    if (analysis && !state.matchFinished.value) {
      safely('abort', () => {
        analysis.noteGap({ scope: 'match', reason: 'match-aborted' })
        void analysis.finish().catch(() => {})
      })
    }
    matchLifecycle.returnToLobby()
  }
  const capabilities = computed(() => ({
    chi: { choose: playerActions.userChi },
    windKong: { available: selectors.userHasWindKong.value, execute: playerActions.userWindKong },
    lotusTable: {
      flipTile: state.flipTile.value,
      jokerTiles: state.jokerTiles.value,
      wildcardTiles: state.wildcardTiles.value,
      wallBreakIndex: state.wallBreakIndex.value,
      flipStack: state.flipStack.value,
    },
  }))

  // 对局回放：开局锚点（发牌/翻精完成）与局末亮牌快照，用 sync 刷新确保取到当下局面。
  if (recorder) {
    watch(state.phase, (phase) => {
      if (phase === 'opening') recorder.roundStart(replayFrame())
    }, { flush: 'sync' })
    watch(state.result, (result) => {
      if (result) recorder.roundEnd(result, replayFrame())
    }, { flush: 'sync' })
  }

  /** 局末结算折算（§5）：每局一条，`deltas = 局末分 − 开局分`（四家之和恒等于牌流的守恒量）。 */
  function recordAnalysisSettlement() {
    if (!analysis) return
    const roundIndex = analysisRoundSequence
    // 局都结束了，还挂着的回执不会再有"下一个窗口"来收尾，必须在这里结掉（§10.2）。
    settleOpenReceipts('round-end')
    const roundId = roundIdOf(roundIndex)
    safely('settlement', () => {
      const records = settlementsFromRound({
        roundIndex,
        roundId,
        openingScores: analysisOpeningScores,
        endingScores: state.players.map((player) => player.score),
        result: state.result.value,
      })
      for (const record of records) analysis.settlement(record)
    })
  }

  // 分析记录的两个局边界，都用 sync 刷新 —— 必须与"局边界"同一拍发生：
  // 开局分数若晚一拍取，第 2 局以后就会取到上一局结算后的值（§5 的 openingScores 正为此必须记）。
  watch(state.phase, (phase) => {
    if (phase !== 'opening') return
    // 连庄也算新的一局（"已打局数 + 1"），所以序号在这里加一，与展示回放同一套口径。
    analysisRoundSequence += 1
    analysisOpeningScores = state.players.map((player) => player.score)
    // 窗口 ID 的计数器是"本局内第 N 次进入决策"（§3.1），所以每局从 1 重新开始。
    analysisWindowCounter = 0
    analysisOpenWindow.clear()
  }, { flush: 'sync' })
  watch(state.result, (result) => {
    // 用对象身份去重：同一局的结算对象只会被折算一次；换局/换场都是新对象。
    if (!result || result === analysisSettledResult) return
    analysisSettledResult = result
    recordAnalysisSettlement()
  }, { flush: 'sync' })

  // 模拟测试里没有组件实例，直接注册会触发 Vue 警告；与 useRemoteGame.ts 同款守卫。
  if (getCurrentInstance()) onBeforeUnmount(clearPresentation)

  return defineGamePort({
    phase: state.phase,
    players: state.players,
    wall: state.wall,
    wallHeadDrawn: state.wallHeadDrawn,
    wallCount: selectors.wallCount,
    currentPlayer: state.currentPlayer,
    selectedIndex: state.selectedIndex,
    turnSeconds: state.turnSeconds,
    lastDiscard: state.lastDiscard,
    actionPrompt: state.actionPrompt,
    announcement: state.announcement,
    tableActionEvent: state.tableActionEvent,
    scoreFlowEvent: state.scoreFlowEvent,
    result: state.result,
    winEffect: state.winEffect,
    winPresentation: state.winPresentation,
    revealHands: state.revealHands,
    winningPlayerIndex: state.winningPlayerIndex,
    round: state.round,
    dealer: state.dealer,
    user: selectors.user,
    isUserTurn: selectors.isUserTurn,
    userCanHu: selectors.userCanHu,
    matchType: state.matchType,
    matchName: selectors.matchName,
    matchFinished: state.matchFinished,
    honba: state.honba,
    roundLabel: selectors.roundLabel,
    standings: selectors.standings,
    dealAnimation: state.dealAnimation,
    openingStage: state.openingStage,
    diceValues: state.diceValues,
    diceThrowerIndex: state.diceThrowerIndex,
    secondDice: state.secondDice,
    userCurrentWaits: selectors.userCurrentWaits,
    userTingOptions: selectors.userTingOptions,
    userDiscardWaits: selectors.userDiscardWaits,
    userKongs: selectors.userKongs,
    capabilities,
    // 莲花麻将专属
    flipTile: state.flipTile,
    jokerTiles: state.jokerTiles,
    wildcardTiles: state.wildcardTiles,
    wallBreakIndex: state.wallBreakIndex,
    flipStack: state.flipStack,
    startGame,
    ...playerActions,
    ...matchLifecycle,
    // 覆盖 matchLifecycle 的原版：退出大厅时先给分析记录收尾（见上面的 returnToLobby）。
    returnToLobby,
    tileName,
    humanController,
    replaceAiControllers,
  })
}

export type LotusGame = ReturnType<typeof useLotusGame>
