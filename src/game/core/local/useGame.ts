import { getCurrentInstance, onBeforeUnmount, ref, watch } from 'vue'
import { defineGamePort, type GameStartOptions } from '../contracts/gamePort'
import type { EndGameOptions, TableActionEvent, TileType } from '../contracts/types'
import type { ReplayFrameSource, ReplayRecorderHooks } from '../../replay/types'
import type { AnalysisChoiceSource, AnalysisExecutionStatus } from '../../replay/analysis/types'
import type { AnalysisRecorder } from '../../replay/analysis/recorder'
import {
  choiceTookEffect,
  decisionStateOf,
  decisionWindowId,
  legalActionId,
  roundKindOfResult,
  settlementsFromScoreChange,
  windowKindOf,
  type LotusClassicActionLike,
  type LotusClassicSeatView,
  type LotusClassicViewLike,
  type LotusClassicWindowKind,
} from '../../replay/analysis/lotusClassicAdapter'
import { AiController, HumanController, type HumanBridge, type PlayerController } from '../controllers/playerController'
import type { ActionContext } from '../rules/actions'
import { tileName } from '../rules/tiles'
import { createLocalCountdownController } from './localCountdownController'
import { createLocalDebugScenarios } from './localDebugScenarios'
import { createLocalGameSelectors, structuralMeldCount } from './localGameSelectors'
import { createLocalGameState } from './localGameState'
import { createLocalKongActionExecutor } from './localKongActionExecutor'
import { createLocalMatchLifecycle } from './localMatchLifecycle'
import { createLocalOpeningTimeline } from './localOpeningTimeline'
import { createLocalPlayerActionController } from './localPlayerActionController'
import { createLocalSettlementTimeline } from './localSettlementTimeline'
import { createLocalTileFlowExecutor } from './localTileFlowExecutor'
import { createLocalTimerScheduler } from './localTimerScheduler'
import { createLocalTransientEventPresenter } from './localTransientEventPresenter'
import { createLocalTurnOrchestrator } from './localTurnOrchestrator'
import { DEFAULT_RULESET, type RuleSet } from '../rules/ruleset'
import { createFollowDealerTracker } from '../../shared/runtime/followDealer'
import type { PlayerSeed } from '../../shared/runtime/localOpening'
import { resolveAnimeAudioPolicy } from '../presentation/animeAudioPolicy'
import {
  ANIME_ACTION_FALLBACK_AUDIO,
  type AnimeFixedTtsExecutor,
  type AnimeSeat,
} from '../../llm/animeFixedTtsExecutor'

const ANIME_FIXED_ACTION_AUDIO_FILES: ReadonlySet<string> = new Set(
  Object.values(ANIME_ACTION_FALLBACK_AUDIO),
)

interface UseGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  controllers?: PlayerController[]
  /** 单机人机：注入座位 1-3 的 AI 控制器（可含 LLM 控制器）；默认启发式 AI 玩家 */
  aiControllers?: PlayerController[]
  /** 单机人机：座位 1-3 的玩家形象（昵称/头像，LLM 人设覆盖） */
  aiPlayerSeeds?: Array<PlayerSeed | undefined>
  /** 单机本家座位 0 的展示形象。 */
  humanPlayerSeed?: PlayerSeed
  /** 由表现层动态读取；规则引擎不得直接访问 DOM 或 URL。 */
  getThemeName?: () => string
  animeFixedTts?: AnimeFixedTtsExecutor
  /** 单机对战是否启用回合倒计时（默认开启；模拟测试依赖倒计时自动出牌/过牌） */
  countdownEnabled?: boolean
  ruleset?: RuleSet
  /** 对局回放录制钩子（可选；不传时零行为变化）。 */
  recorder?: ReplayRecorderHooks
  /**
   * AI 分析记录（可选；方案 §3.2）。引擎拿到的是一个**稳定代理**（换场只换内部录制器），
   * 不传或关闭时所有写入空转、零成本；记录代码自身永不抛错，绝不影响对局（§9.5）。
   */
  analysis?: AnalysisRecorder | null
}

export function useGame({
  playSound = () => {},
  playSoundAndWait = async () => {},
  controllers: suppliedControllers,
  aiControllers,
  aiPlayerSeeds,
  humanPlayerSeed,
  getThemeName = () => 'jade',
  animeFixedTts,
  countdownEnabled = true,
  ruleset = DEFAULT_RULESET,
  recorder,
  analysis = null,
}: UseGameOptions = {}) {
  const state = createLocalGameState()
  const selectors = createLocalGameSelectors(state, ruleset)

  // ── 对局回放录制 ──
  // 只读局面快照：录制器不认识引擎内部结构，全靠这个对象取值。
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
    diceThrowerIndex: state.diceThrowerIndex.value,
    wallBreakIndex: state.wallBreakIndex.value,
  })
  let openingTimeline!: ReturnType<typeof createLocalOpeningTimeline>
  let settlementTimeline!: ReturnType<typeof createLocalSettlementTimeline>
  let kongActionExecutor!: ReturnType<typeof createLocalKongActionExecutor>
  let turnOrchestrator!: ReturnType<typeof createLocalTurnOrchestrator>
  let tileFlowExecutor!: ReturnType<typeof createLocalTileFlowExecutor>
  let playerActions!: ReturnType<typeof createLocalPlayerActionController>
  let countdown!: ReturnType<typeof createLocalCountdownController>
  let transientEvents!: ReturnType<typeof createLocalTransientEventPresenter>

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

  const humanBridge: HumanBridge = {
    isTurn: ref(false),
    canHu: ref(false),
    canKong: ref<TileType[]>([]),
    actionPrompt: state.actionPrompt,
    selectedIndex: state.selectedIndex,
    drawnThisTurn: state.userDrewThisTurn,
    turnSeconds: state.turnSeconds,
    activateTurn() {
      state.phase.value = 'discard'
      countdown.startTurn()
    },
    activateClaim() {
      state.phase.value = 'prompt'
      countdown.startPrompt()
    },
    activateRobKong() {
      state.phase.value = 'prompt'
      transientEvents.announce('可抢杠胡', 'red')
      countdown.startPrompt()
    },
    deactivate() {
      countdown?.stop()
    },
  }
  const humanController = new HumanController(humanBridge)
  const controllers: PlayerController[] = suppliedControllers ?? [
    humanController,
    ...(aiControllers && aiControllers.length ? aiControllers : [new AiController(), new AiController(), new AiController()]),
  ]

  // 设置页只在大厅开放；保存后替换内部数组，使下一次开局读取新的 AI 控制器。
  // 调用方不能直接替换 aiControllers 参数，因为下游编排器持有的是这个数组的引用。
  function replaceAiControllers(nextControllers?: PlayerController[] | null) {
    const replacement = nextControllers && nextControllers.length
      ? nextControllers
      : [new AiController(), new AiController(), new AiController()]
    controllers.splice(1, Math.max(0, controllers.length - 1), ...replacement)
  }

  // ── AI 分析记录（方案 §3.2；约定 §1 属于 A 的路径）──
  // 旁路观测，只写不读：不改变任何返回值、不改变决策顺序，也**永不抛错**（§9.5、§10.1）。
  // 三个决策汇聚点就是控制器本身（回合/响应/抢杠）——从外面包一层，比在每个编排器里插桩稳。
  const monotonicNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  /** 本局序号（1 起）：每次进入开局阶段 +1。 */
  let analysisRoundIndex = 0
  /** 本局内第 N 次进入决策：窗口 ID 用它（计数器，不用时间戳/帧号，才能离线复算，§3.1）。 */
  let analysisWindowSeq = 0
  /** 已提交、等观察的动作（执行回执用"动作是否真的改了状态"判定，§3.2）。 */
  const analysisPending = new Map<number, {
    windowId: string
    seat: number
    action: LotusClassicActionLike
    before: LotusClassicViewLike
  }>()
  /** 上一次结算流水记到的分数（按绝对座位）：每次变化都从它算 delta。 */
  let analysisLastScores: number[] = state.players.map((player) => player.score)
  /** 分数变化合并标志：一次结算连写四家分数，合并成一条流水。 */
  let analysisScorePending = false
  /**
   * 本局的开局分基线是否已就绪（在本局第一个决策窗口置位）。
   * 开局建玩家本身就会写一次分数（空 → 起始分），那不是结算，绝不能记成一条流水。
   */
  let analysisBaselineReady = false
  /** 本局结束的类型（由 state.result 的同步 watch 写入，供流水标注 kind）。 */
  let analysisRoundEndKind: string | null = null
  let analysisSettlementSeq = 0

  /**
   * 把"分数实际变了多少"折算成一条结算流水（§5）。
   * 引擎不变量是四家变化之和为 0；这里若发现不为 0 也照实记录，不做修补 —— 读取侧要能看出来。
   */
  function analysisFlushScores(): void {
    analysisScorePending = false
    const after = state.players.map((player) => player.score)
    const changed = after.some((score, seat) => score !== (analysisLastScores[seat] ?? 0))
    if (!changed) return
    // 基线没就绪（本局还没进入任何决策窗口）时不记流水：开局建玩家会写一次分数，
    // 那是初始化不是结算；真的分数变化必然晚于本局第一个窗口。
    if (!analysisBaselineReady) {
      analysisLastScores = after
      return
    }
    const before = analysisLastScores
    analysisLastScores = after
    const kind = analysisRoundEndKind ?? 'score-flow'
    analysisRoundEndKind = null
    if (!analysis) return
    try {
      analysisSettlementSeq += 1
      analysis.settlement(settlementsFromScoreChange({
        roundIndex: analysisRoundIndex,
        roundId: String(analysisRoundIndex),
        before,
        after,
        kind,
        sourceEventId: `score-${analysisRoundIndex}-${analysisSettlementSeq}`,
      }))
    } catch { /* 记录失败不影响对局 */ }
  }

  const analysisSeatView = (seat: number): LotusClassicSeatView => {
    const player = state.players[seat]
    return {
      seat,
      handCount: player?.hand.length ?? 0,
      // 四家真实手牌都交给适配层：前态只露决策者那一份是**适配层的责任**，靠它把关才可测
      hand: [...(player?.hand ?? [])],
      drawnTileIndex: player?.drawnTileIndex ?? -1,
      discards: [...(player?.discards ?? [])],
      melds: [...(player?.melds ?? [])],
      score: player?.score ?? 0,
    }
  }

  const analysisView = (
    seat: number,
    windowId: string,
    kind: LotusClassicWindowKind,
    actions: ReadonlyArray<LotusClassicActionLike>,
  ): LotusClassicViewLike => ({
    windowId,
    roundId: String(analysisRoundIndex),
    roundIndex: analysisRoundIndex,
    seat,
    windowKind: kind,
    actions,
    players: state.players.map((_, index) => analysisSeatView(index)),
    wallCount: state.wall.value.length,
    dealer: state.dealer.value,
    currentPlayer: state.currentPlayer.value,
    wall: [...state.wall.value],
    roundEnded: Boolean(state.result.value),
    winningSeat: state.result.value ? state.winningPlayerIndex.value : null,
  })

  /** 该座位此刻引擎**接受**的动作（口径对齐 localTurnOrchestrator 的 handleAction / offerNextClaim / offerRobKong）。 */
  function analysisLegalActions(kind: LotusClassicWindowKind, ctx: Record<string, unknown>): LotusClassicActionLike[] {
    const hand = (ctx.hand as TileType[] | undefined) ?? []
    const actions: LotusClassicActionLike[] = []
    if (kind === 'turn') {
      const skipDraw = Boolean(ctx.skipDraw)
      if (!skipDraw) {
        const melds = (ctx.melds as Array<{ type: string; tile: TileType }> | undefined) ?? []
        melds.forEach((meld, meldIndex) => {
          if (meld.type === 'peng' && hand.includes(meld.tile)) {
            actions.push({ kind: 'added-kong', meldIndex, tile: meld.tile })
          }
        })
        for (const tile of ruleset.win.concealedKongs(hand)) {
          actions.push({ kind: 'concealed-kong', tile })
        }
        if (ruleset.win.isWinningHand(hand, (ctx.exposedMelds as number | undefined) ?? 0)) {
          actions.push({ kind: 'win' })
        }
      }
      // 每个手牌下标都是一条合法弃牌：摸切/手切靠下标区分，不能只按牌种去重（§3.3）
      hand.forEach((tile, handIndex) => actions.push({ kind: 'discard', tile, handIndex }))
      return actions
    }
    if (kind === 'claim') {
      if (ctx.canPeng) actions.push({ kind: 'peng', tile: ctx.tile as TileType, from: ctx.from as number })
      if (ctx.canGang) actions.push({ kind: 'gang', tile: ctx.tile as TileType, from: ctx.from as number })
      actions.push({ kind: 'pass' })
      return actions
    }
    if (ruleset.win.canRobKong(hand, ctx.tile as TileType, (ctx.exposedMelds as number | undefined) ?? 0)) {
      actions.push({ kind: 'win' })
    }
    actions.push({ kind: 'pass' })
    return actions
  }

  /** 动作相等判据：能区分同种动作的不同对象（下标/组合），否则会把"换了张牌打"当成同一个动作。 */
  function analysisSameAction(left: LotusClassicActionLike, right: LotusClassicActionLike): boolean {
    if (left.kind !== right.kind) return false
    if (left.kind === 'discard') return left.handIndex === right.handIndex
    if (left.kind === 'added-kong') return left.meldIndex === right.meldIndex
    if (left.kind === 'concealed-kong') return left.tile === right.tile
    return true
  }

  /** 座位控制方式：接管或回退不能只看开局角色（§3.1）。LLM 座位本轮先记 unknown（§9 的 DoD）。 */
  function analysisSourceOf(seat: number): AnalysisChoiceSource {
    if (controllers[seat] === humanController) return 'human'
    const player = state.players[seat]
    return player?.isLlm || player?.playerKind === 'llm' ? 'unknown' : 'rule-auto'
  }

  /**
   * 进入一次决策：开窗口 + 写前态，返回"记下选择"的回调。
   * 每个 (窗口, 座位) 只开一次；记录失败一律吞掉（§9.5）。
   */
  function analysisOpen(
    seat: number,
    kind: LotusClassicWindowKind,
    ctx: Record<string, unknown>,
  ): ((action: LotusClassicActionLike | null) => void) | null {
    if (!analysis) return null
    try {
      analysisWindowSeq += 1
      const actions = analysisLegalActions(kind, ctx)
      const windowId = decisionWindowId(String(analysisRoundIndex), analysisWindowSeq)
      // 本局开局分：在**本局第一个决策窗口**取基线并置位就绪（开局阶段刚建好玩家时分数还没落定，
      // 那时取会把 0 当成开局分；而本局第一次真的分数变化必然晚于第一个窗口）。
      if (analysisWindowSeq === 1) {
        analysisLastScores = state.players.map((player) => player.score)
        analysisBaselineReady = true
      }
      const view = analysisView(seat, windowId, kind, actions)
      analysis.windowOpened({
        windowId,
        seat,
        windowKind: windowKindOf(kind),
        roundIndex: analysisRoundIndex,
        // 经典玩法没有权威代次/状态版本号：用局号与"本局第 N 次进入决策"顶上，
        // 同一窗口内稳定、跨局不重复（口径见 docs/blood-flow/design/analysis-lotus-classic.md）
        authorityEpoch: `round-${analysisRoundIndex}`,
        stateVersion: analysisWindowSeq,
        state: decisionStateOf(view, seat),
        openedAt: monotonicNow(),
      })
      return (action) => {
        try {
          const index = action
            ? actions.findIndex((candidate) => analysisSameAction(candidate, action))
            : -1
          analysis.chosen({
            windowId,
            seat,
            legalActionId: index >= 0 ? legalActionId(windowId, index) : null,
            source: analysisSourceOf(seat),
            at: monotonicNow(),
          })
          if (!action) return
          analysisPending.set(seat, { windowId, seat, action, before: view })
          // 过牌不会有任何"上桌"事件，但它确实生效（本座位状态不变）。
          // 让出一个宏任务再按状态比对判定，用的是适配层同一套 choiceTookEffect（§3.2）。
          if (action.kind === 'pass') {
            scheduler.later(() => analysisSettleReceipt(seat, null), 0)
          }
        } catch { /* 记录失败不影响对局 */ }
      }
    } catch {
      return null
    }
  }

  /**
   * 动作真的执行了才记回执：`executed` 只在观察到该动作改变了本座位状态时写，
   * 观察到的动作与所选的不是同一个就是 `state-changed`（引擎可能按当前状态改判）。
   * 什么都没观察到就保持 pending —— 请求成功不等于执行成功（§3.2、§10.2）。
   */
  function analysisSettleReceipt(seat: number, observed: LotusClassicActionLike | null, eventId?: string): void {
    const pending = analysisPending.get(seat)
    if (!pending || !analysis) return
    try {
      const after = analysisView(seat, pending.windowId, 'turn', [])
      const executed = observed
        ? analysisSameAction(pending.action, observed)
        : choiceTookEffect(pending.before, after, seat, pending.action)
      const status: AnalysisExecutionStatus = executed ? 'executed' : 'state-changed'
      analysis.receipt({
        windowId: pending.windowId,
        seat,
        status,
        ...(eventId !== undefined ? { eventId } : {}),
        ...(executed ? {} : { detail: observed ? `实际执行的是 ${observed.kind}` : '状态未按所选变化' }),
      })
    } catch { /* 记录失败不影响对局 */ }
    analysisPending.delete(seat)
  }

  /**
   * 座位控制器代理：只旁路观察，**原样转发**每个方法（含 reset/onDiscarded 等）。
   * 按座位取活的 `controllers[seat]`，因此设置页换控制器（replaceAiControllers）后依然指向新对象。
   */
  function analysisSeat(seat: number): PlayerController {
    return {
      async requestTurn(ctx) {
        const close = analysisOpen(seat, 'turn', ctx as unknown as Record<string, unknown>)
        const action = await controllers[seat]!.requestTurn(ctx)
        close?.(action as unknown as LotusClassicActionLike)
        return action
      },
      async requestClaim(ctx) {
        const close = analysisOpen(seat, 'claim', ctx as unknown as Record<string, unknown>)
        const action = await controllers[seat]!.requestClaim(ctx)
        close?.(action as unknown as LotusClassicActionLike)
        return action
      },
      async requestRobKong(ctx) {
        const close = analysisOpen(seat, 'rob-kong', ctx as unknown as Record<string, unknown>)
        const action = await controllers[seat]!.requestRobKong(ctx)
        close?.(action ? { kind: action } : null)
        return action
      },
      onDiscarded: () => controllers[seat]?.onDiscarded?.(),
      reset: () => controllers[seat]?.reset?.(),
    }
  }
  // 只在接了分析记录时才代理：不接时对局路径与改动前逐字相同（零行为变化）。
  const seatControllers: PlayerController[] = analysis
    ? controllers.map((_, seat) => analysisSeat(seat))
    : controllers

  const scheduler = createLocalTimerScheduler({
    // 分析记录接缝只在接了录制器时才代理；两个分支都由 seatControllers 表达（不接 = 原数组）
    controllers: seatControllers,
    stopCountdown: () => countdown?.stop(),
    cancelOpening: () => openingTimeline?.cancel(),
  })
  const clearPresentation = () => {
    scheduler.clear()
    animeFixedTts?.cancel()
  }
  transientEvents = createLocalTransientEventPresenter({
    state,
    later: scheduler.later,
    onTableAction: playAnimeAction,
  })
  if (recorder) {
    // 碰/吃/杠/胡的唯一统一出口：所有鸣牌与胡牌动作都会经过 showTableAction。
    const baseShowTableAction = transientEvents.showTableAction
    transientEvents.showTableAction = (type, actorIndex, sourceIndex, tile, meldIndex) => {
      baseShowTableAction(type, actorIndex, sourceIndex, tile, meldIndex)
      recorder.tableAction({ type, actorIndex, sourceIndex, tile, meldIndex }, replayFrame())
    }
  }
  if (analysis) {
    // 执行回执的观察点：鸣牌/杠/胡真的上了桌才算生效（§3.2）。
    // 与回放录制各自包一层，互不依赖 —— 只开回放或只开分析都不影响对方。
    const baseShowTableAction = transientEvents.showTableAction
    transientEvents.showTableAction = (type, actorIndex, sourceIndex, tile, meldIndex) => {
      baseShowTableAction(type, actorIndex, sourceIndex, tile, meldIndex)
      const observed: LotusClassicActionLike | null = type === 'peng' || type === 'chi' ? { kind: type }
        : type === 'added-gang' ? { kind: 'added-kong', meldIndex }
          : type === 'concealed-gang' ? { kind: 'concealed-kong', tile: tileName(tile) }
            : type === 'wind-kong' ? { kind: 'wind-kong' }
              : type === 'self-draw' || type === 'discard-win' || type === 'robbed-kong-win' ? { kind: 'win' }
                : type === 'discard-gang' || type === 'flower-gang' ? { kind: 'gang' }
                  : null
      if (observed) analysisSettleReceipt(actorIndex, observed)
    }
  }

  // 跟庄：开局第一圈，庄家首弃后三闲家各出一张同牌 → 庄家向三家各付底分。
  const followDealer = createFollowDealerTracker({
    players: state.players,
    dealerIndex: () => state.dealer.value,
    baseScore: ruleset.baseScore,
    onTrigger: (deltas) => {
      transientEvents.showScoreFlow(deltas)
      transientEvents.announce('跟庄')
    },
  })

  function endGame(winnerIndex: number, options: EndGameOptions = {}) {
    return settlementTimeline.endGame(winnerIndex, options)
  }

  function endDraw() {
    return settlementTimeline.endDraw()
  }

  function beginTurn(playerIndex: number, options: { skipDraw?: boolean; fromTail?: boolean } = {}) {
    return turnOrchestrator.beginTurn(playerIndex, options)
  }

  settlementTimeline = createLocalSettlementTimeline({
    state,
    clearTimers: clearPresentation,
    later: scheduler.later,
    playSound: playPresentationSound,
    playSoundAndWait: playPresentationSoundAndWait,
    showTableAction: transientEvents.showTableAction,
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

  tileFlowExecutor = createLocalTileFlowExecutor({
    state,
    controllers: seatControllers,
    getTurnOrchestrator: () => turnOrchestrator,
    endDraw,
    endGame,
    showTableAction: transientEvents.showTableAction,
    playSound: playPresentationSound,
    playSoundAndWait: playPresentationSoundAndWait,
    shouldAnnounceDiscard: (_playerIndex, player) => (
      resolveAnimeAudioPolicy({
        themeName: getThemeName(),
        playerKind: player.playerKind,
        isLlm: player.isLlm,
      }).discard.tileName !== 'suppress'
    ),
    later: scheduler.later,
    wait: scheduler.wait,
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
  if (analysis) {
    // 弃牌回执的观察点：牌真的进了牌河才算生效。引擎可能按当前状态改判（越界下标退回摸切），
    // 这种情况下观察到的下标与所选不一致 ⇒ 记 state-changed，而不是 executed。
    const baseDiscardTile = tileFlowExecutor.discardTile
    tileFlowExecutor.discardTile = (playerIndex: number, requestedIndex: number) => {
      const before = state.players[playerIndex]?.discards.length ?? 0
      // discardTile 会把越界下标夹到末张：记录**实际用的下标**，才能区分"按所选执行"与"引擎改判"
      const handLength = state.players[playerIndex]?.hand.length ?? 0
      const usedIndex = Math.max(0, Math.min(requestedIndex, handLength - 1))
      baseDiscardTile(playerIndex, requestedIndex)
      const player = state.players[playerIndex]
      if (!player || player.discards.length <= before) return
      const tile = player.discards[player.discards.length - 1]!
      analysisSettleReceipt(playerIndex, { kind: 'discard', tile, handIndex: usedIndex })
    }
  }

  openingTimeline = createLocalOpeningTimeline({
    state,
    clearTimers: clearPresentation,
    takeTile: tileFlowExecutor.takeTile,
    wait: scheduler.wait,
    later: scheduler.later,
    playSound: playPresentationSound,
    playSoundAndWait: playPresentationSoundAndWait,
    announce: transientEvents.announce,
    getRoundLabel: () => selectors.roundLabel.value,
    beginTurn,
    endGame,
    playerSeeds: aiPlayerSeeds,
    humanPlayerSeed,
  })
  // 每局开局先复位跟庄窗口，再走开局时间线。
  const startGame = (mode?: Parameters<typeof openingTimeline.start>[0], options?: GameStartOptions) => {
    animeFixedTts?.reset()
    followDealer.reset()
    return openingTimeline.start(mode, options)
  }

  const tableContext: ActionContext = {
    players: state.players,
    currentPlayer: state.currentPlayer,
    showTableAction: transientEvents.showTableAction,
    showScoreFlow: transientEvents.showScoreFlow,
    playSound: playPresentationSound,
  }
  kongActionExecutor = createLocalKongActionExecutor({
    state,
    showTableAction: transientEvents.showTableAction,
    showScoreFlow: transientEvents.showScoreFlow,
    playSound: playPresentationSound,
    later: scheduler.later,
    beginTurn,
    ruleset,
  })
  turnOrchestrator = createLocalTurnOrchestrator({
    state,
    controllers: seatControllers,
    tableContext,
    structuralMeldCount: (playerIndex) => structuralMeldCount(state.players[playerIndex]),
    drawFor: tileFlowExecutor.drawFor,
    performConcealedKong: kongActionExecutor.performConcealedKong,
    declareAddedKong: kongActionExecutor.declareAddedKong,
    settleAddedKong: kongActionExecutor.settleAddedKong,
    discardTile: tileFlowExecutor.discardTile,
    endDraw,
    endGame,
    announce: transientEvents.announce,
    later: scheduler.later,
    ruleset,
    followDealer,
  })

  playerActions = createLocalPlayerActionController({
    state,
    humanController,
    tableContext,
    turnOrchestrator,
    kongActionExecutor,
    getUser: () => selectors.user.value,
    isUserTurn: () => selectors.isUserTurn.value,
    canUserHu: () => selectors.userCanHu.value,
    getUserKongs: () => selectors.userKongs.value,
    stopCountdown: countdown.stop,
    startTurnCountdown: countdown.startTurn,
    discardTile: tileFlowExecutor.discardTile,
    beginTurn: (playerIndex, options) => beginTurn(playerIndex, options),
    endGame,
    announce: transientEvents.announce,
    playSound: playPresentationSound,
    later: scheduler.later,
  })

  const matchLifecycle = createLocalMatchLifecycle({ state, clearTimers: clearPresentation, startGame })
  const debugScenarios = createLocalDebugScenarios({
    state,
    clearTimers: clearPresentation,
    resetPlayers: openingTimeline.resetPlayers,
    announce: transientEvents.announce,
    endGame,
    endDraw,
    beginTurn: (playerIndex) => beginTurn(playerIndex),
  })

  // 对局回放：开局锚点（发牌完成）与局末亮牌快照。
  // 用 sync 刷新：必须在引擎写下该状态的同一刻取快照，避免被随后的 nextRound / 清场抢先。
  if (recorder) {
    watch(state.phase, (phase) => {
      if (phase === 'opening') recorder.roundStart(replayFrame())
    }, { flush: 'sync' })
    watch(state.result, (result) => {
      if (result) recorder.roundEnd(result, replayFrame())
    }, { flush: 'sync' })
  }

  // ── 分析记录：局书号、结算流水与中途退出 ──
  if (analysis) {
    // 每局开局：局号 +1、窗口计数清零。窗口 ID 才能"本局内稳定、跨局不重复"（§3.1）。
    watch(state.phase, (phase) => {
      if (phase !== 'opening') return
      analysisRoundIndex += 1
      analysisWindowSeq = 0
      analysisPending.clear()
      analysisBaselineReady = false
    }, { flush: 'sync' })

    // 本局结束的类型（自摸/点杠/抢杠/荒庄）：与分数变化同一批同步写入，供下面的流水标注 kind。
    watch(state.result, (result) => {
      if (result) analysisRoundEndKind = roundKindOfResult(result)
    }, { flush: 'sync' })

    // 结算流水：经典玩法没有权威账本，按**分数实际变化**折算，每次变化一条（四家变化之和恒为 0）。
    // 一次结算会连写四家分数，因此用微任务合并：不合并就会记出几条不守恒的半截流水。
    watch(() => state.players.map((player) => player.score), () => {
      if (analysisScorePending) return
      analysisScorePending = true
      void Promise.resolve().then(analysisFlushScores)
    }, { flush: 'sync' })

    // 中途退出（未打完整场）：如实留痕并结束本场。不收尾的话会话会一直是 active，
    // 下一场的 start() 会被守卫跳过，新对局的记录就挂到上一场的 matchId 上了（错场归属）。
    watch(state.phase, (phase) => {
      if (phase !== 'lobby') return
      if (analysisRoundIndex === 0 || state.matchFinished.value) return
      try {
        analysis.noteGap({ scope: 'match', reason: 'match-aborted' })
        void analysis.finish().catch(() => {})
      } catch { /* 记录失败不影响对局 */ }
    }, { flush: 'sync' })
  }

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
    userCurrentWaits: selectors.userCurrentWaits,
    userTingOptions: selectors.userTingOptions,
    userDiscardWaits: selectors.userDiscardWaits,
    userKongs: selectors.userKongs,
    capabilities: ref({}),
    startGame,
    ...playerActions,
    ...matchLifecycle,
    tileName,
    ...debugScenarios,
    humanController,
    replaceAiControllers,
  })
}
