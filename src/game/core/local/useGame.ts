import { computed, getCurrentInstance, onBeforeUnmount, ref, watch } from 'vue'
import { defineGamePort, type GameStartOptions } from '../contracts/gamePort'
import type { EndGameOptions, TableActionEvent, TileType } from '../contracts/types'
import { createWall, TILE_TYPES } from '../rules/tiles'
import type { ReplayFrameSource, ReplayRecorderHooks } from '../../replay/types'
import type { AnalysisChoiceSource, AnalysisExecutionStatus } from '../../replay/analysis/types'
import type { AnalysisCommandEntry } from '../../replay/analysis/commandEntry'
import type { AnalysisRecorder } from '../../replay/analysis/recorder'
import {
  buildLotusClassicReproduction,
  lotusClassicCommandEntry,
  ringWallDeficiencies,
} from '../../replay/analysis/lotusClassicReproduction'
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
  /** P2P 房主权威：非本家座位的远端控制器，优先于单机 AI 控制器。 */
  remoteControllers?: Array<PlayerController | undefined>
  /** 单机人机：座位 1-3 的玩家形象（昵称/头像，LLM 人设覆盖） */
  aiPlayerSeeds?: Array<PlayerSeed | undefined>
  /** 单机本家座位 0 的展示形象（昵称/头像/角色）。 */
  humanPlayerSeed?: PlayerSeed
  /** 单机对战是否启用回合倒计时（默认开启；模拟测试依赖倒计时自动出牌/过牌） */
  countdownEnabled?: boolean
  /** 房主权威联机：开局瞬间发牌（无动画），供客户端用全量手牌快照自行动画发牌。 */
  instantOpening?: boolean
  /** 无头权威引擎：即时节奏（PACE_MS/结算动画归零）+ 即时开局，逻辑即时推进、表现层交给 viewer。 */
  headless?: boolean
  /** 房主权威联机：每一局进入首回合前等待所有在线客户端完成开局表现。 */
  waitForOpeningReady?: () => Promise<void>
  /** 表现层动态读取当前牌桌主题（二次元主题声音策略据此决定是否报牌名）。 */
  getTableThemeName?: () => string
  /** 二次元固定台词执行器（吃碰杠胡动作音 + 胡牌后结算台词）。 */
  animeFixedTts?: AnimeFixedTtsExecutor
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
  remoteControllers,
  aiPlayerSeeds,
  humanPlayerSeed,
  countdownEnabled = true,
  instantOpening = false,
  headless = false,
  waitForOpeningReady,
  getTableThemeName = () => 'jade',
  animeFixedTts,
  ruleset = DEFAULT_RULESET,
  recorder,
  analysis = null,
}: UseGameOptions = {}) {
  const sound = headless ? () => {} : playSound
  const soundAndWait = headless ? async () => {} : playSoundAndWait
  const openingInstant = headless || instantOpening

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
    themeName: getTableThemeName(),
    playerKind: 'unknown',
  }).actionVoice === 'fixed-line'
  const playPresentationSound = (name: string, volume?: number, onFinish?: () => void) => {
    if (usesAnimeFixedActionVoice() && ANIME_FIXED_ACTION_AUDIO_FILES.has(name)) return
    if (onFinish !== undefined) return sound(name, volume, onFinish)
    if (volume !== undefined) return sound(name, volume)
    return sound(name)
  }
  const playPresentationSoundAndWait = (name: string, volume?: number) => (
    usesAnimeFixedActionVoice() && ANIME_FIXED_ACTION_AUDIO_FILES.has(name)
      ? Promise.resolve()
      : soundAndWait(name, volume)
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
      if (result.fallbackAudioFile) sound(result.fallbackAudioFile)
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
    remoteControllers?.[0] ?? aiControllers?.[0] ?? new AiController(),
    remoteControllers?.[1] ?? aiControllers?.[1] ?? new AiController(),
    remoteControllers?.[2] ?? aiControllers?.[2] ?? new AiController(),
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
    kind: LotusClassicWindowKind
    action: LotusClassicActionLike
    before: LotusClassicViewLike
  }>()
  /** 上一次结算流水记到的分数（按绝对座位）：每次变化都从它算 delta。 */
  let analysisLastScores: number[] = state.players.map((player) => player.score)
  /** 分数变化合并标志：一次结算连写四家分数，合并成一条局中流水。 */
  let analysisScorePending = false
  /** 本局结束的类型（由 state.result 的同步 watch 写入，供流水标注 kind）。 */
  let analysisRoundEndKind: string | null = null
  let analysisSettlementSeq = 0
  /**
   * 本局的**开局分**（四家）：每次进入开局阶段时取，是结算折算与复现数据共用的基准。
   *
   * 为什么必须单独留一份、不能拿 `analysisLastScores` 顶：后者会被局中的每一次分数变化推进，
   * 到局末它记的是"上一次变化之后"的分数，不是开局分。P1 的复现字段 `openingScores` 与
   * 结算流水的 `deltas` 都要拿**开局分**当基准，否则第 2 局以后对不上（§6 的 openingScores 正为此存在）。
   */
  let analysisOpeningScores: number[] = state.players.map((player) => player.score)
  /** 本局是否已经落过局末结算（同一次结束不得重复记：微任务里的分数冲刷会再触发一次）。 */
  let analysisRoundSettled = false
  /**
   * 已经折算过结算的那一份 `state.result`（同一局不得重复记：对象身份即"这一次结算"）。
   * 换局/换场都是新对象，所以不需要额外的清零动作。
   */
  let analysisSettledResult: unknown = null

  // ── P1 §6：本局的**复现数据**（重跑起点 + 权威动作日志） ────────────────────────────
  //
  // 与 P0 的"决策记录"共用同一批汇聚点，但两件事不同：P0 记的是"**当时决策是什么**"，
  // P1 记的是"**能不能把这一局重跑出来**"。后者需要三样东西：确定性起点（环状牌墙 136 张 +
  // 开局骰子 + 庄家）、当局开局分（否则结束分数无从比对）、以及**权威真正执行过的动作序列**。
  //
  // 广麻**没有翻精** ⇒ 这一份里**没有** `flipTile`/`jokers`/`flipSeat`/`flipStack`
  // 那一套（`localOpeningTimeline` 里连 `resolveFlip` 都没有）。不要为了与翻精癞子对齐而补空值：
  // 读取侧要能如实看出"广麻本来就没有翻精"，而不是读到一组空值以为"翻精没翻出来"。
  /**
   * 本局的**重跑起点参数**（环状牌墙 136 + 开局骰子 + 庄家 + 牌山断点），由开局时间线的
   * `onRoundPrepared` 在"骰子掷完、牌墙按庄家拆开、**还没发牌**"那一刻交出。
   * 必须在那一刻拿：此后 `state.wall` 会被发完，局末读它拿到的是**终局牌墙**。
   */
  let analysisRoundRing: {
    ringWall: string[]
    firstDice: [number, number]
    dealer: number
    wallBreakIndex: number
    openingScores: number[]
  } | null = null
  /**
   * 本局**发牌完成、进入第一手决策之前**那一拍的读数（`beginTurn` 回调时刻）：四家手牌。
   * 手牌是**交叉校验**输入（证明重跑与记录是同一副牌；广麻没有翻精，所以只有这一项要交叉校验）。
   */
  let analysisRoundOpening: {
    roundIndex: number
    postDealHands: string[][]
  } | null = null
  /**
   * 本局的权威动作序列：与 P0 的 `chosen` **同源、同顺序**（在同一个汇聚点各落一份）。
   * 顺序判据是 `windowId`（末段自增编号），不是数组下标 —— 异步回传会让数组顺序 ≠ 执行顺序。
   */
  const analysisRoundCommands: AnalysisCommandEntry[] = []

  /**
   * 记录代码的**唯一**执行口：任何记录侧异常都只吞掉并留痕。
   * §9.5：分析落库失败最多让这一场不完整，绝不能把异常抛回对局路径。
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

  /**
   * 把"分数实际变了多少"折算成一条**局中**流水（§5）。
   *
   * 与 `recordAnalysisSettlement`（局末那条）的分工：
   * - 这里记**局中**的分数流动（跟庄、杠分这类还没结束时的变化），它撑起"流水首尾相接"这条
   *   P0 判据（`useGame.analysis.test.ts` 断言相邻两条 `before` 与上一条 `scoresAfter` 一致）；
   * - 局末由 `recordAnalysisSettlement` 记一条"开局分 → 局末分"，**并把 `analysisLastScores`
   *   同步到局末分**，所以本函数在局末不会再记出一条重复流水（那个时刻 delta 恒为 0）。
   *
   * 引擎不变量是四家变化之和为 0；这里若发现不为 0 也照实记录，不做修补 —— 读取侧要能看出来。
   */
  function analysisFlushScores(): void {
    analysisScorePending = false
    const after = state.players.map((player) => player.score)
    // 第一局开局之前**不记流水**：建玩家本身就会写一次分数（空 → 起始分），那是初始化不是结算。
    // 真的分数变化必然晚于本局开局（`analysisRoundIndex` 在进入开局阶段那一拍才 +1）。
    // 少了这道闸，那一次初始化会被记成一条 `deltas=[1000,1000,1000,1000]` 的"结算"（实测抓到过）。
    if (analysisRoundIndex === 0) {
      analysisLastScores = after
      return
    }
    if (!after.some((score, seat) => score !== (analysisLastScores[seat] ?? 0))) return
    const before = analysisLastScores
    analysisLastScores = after
    if (!analysis) return
    try {
      analysisSettlementSeq += 1
      analysis.settlement(settlementsFromScoreChange({
        roundIndex: analysisRoundIndex,
        roundId: String(analysisRoundIndex),
        before,
        after,
        // 局中的分数流动一律记 `score-flow`（跟庄/杠分），结算型 kind 留给局末那条。
        kind: 'score-flow',
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
      // 该座位上一次的选择若始终没被观察到（引擎拒了、或收尾把延迟检查清掉了），
      // 条目留在表里会让**下一个窗口**的观察错记到旧窗口上 ⇒ 开新窗口时先丢掉它。
      // 丢掉 = 那条决策保持 pending（"已提交但未观察到回执"），这是诚实的默认值；
      // 错记成 state-changed 才是说谎。
      analysisPending.delete(seat)
      const windowId = decisionWindowId(String(analysisRoundIndex), analysisWindowSeq)
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
          // P1 §6：在**同一个汇聚点**再落一条可重跑的命令（形状 = `AnalysisCommandEntry`）。
          // 单独一个 `try` 包住：上面那条决策记录失败不该连带丢掉可重跑的动作序列（§9.5 独立失败域）。
          // 条目带 `legalActionId` 当且仅当该动作确实落在本窗口的合法动作里（与 P0 同一条判据）——
          // 校验器据此区分"记录侧自己标了当时不合法"与"重跑侧状态分叉了"。
          try {
            if (action) {
              analysisRoundCommands.push(lotusClassicCommandEntry(seat, action, {
                at: Date.now(),
                windowId,
                // 与决策记录的 `windowKind` **同一口径**（`windowKindOf` 的产物，即
                // `AnalysisWindowKind`）：两处若一套写 `turn`、一套写 `draw-turn`，
                // P1 的校验器拿记录与重跑逐号对照时第 1 个窗口就会误报"类型对不上"（实测踩过）。
                windowKind: windowKindOf(kind),
                ...(index >= 0 ? { legalActionId: legalActionId(windowId, index) } : {}),
              }))
            }
          } catch { /* 命令日志失败不影响对局，也不影响上面那条决策记录 */ }
          if (!action) return
          analysisPending.set(seat, { windowId, seat, kind, action, before: view })
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
      const after = analysisView(seat, pending.windowId, pending.kind, [])
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
  // 无头仅让「结算动画」即时（胡牌特效/亮牌等待归零），出牌/碰杠的 PACE_MS 节奏保留，
  // 否则玩家看不清弃牌，出牌动画消失。
  const settlementLater = headless
    ? (callback: () => void) => scheduler.later(callback, 0)
    : scheduler.later
  transientEvents = createLocalTransientEventPresenter({ state, later: scheduler.later, onTableAction: playAnimeAction })
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
    // P1 §6：每局的**第一个回合**（庄家起手）就是"发牌完成、还没进入第一手决策"那一刻 ——
    // 复现快照在这里取（每局只取一次）。局末再读 `state.players` 拿到的是**终局**手牌与分数，
    // 拿它当"起始状态"就是血流踩过的那个坑。
    captureAnalysisOpening()
    return turnOrchestrator.beginTurn(playerIndex, options)
  }

  settlementTimeline = createLocalSettlementTimeline({
    state,
    clearTimers: clearPresentation,
    later: settlementLater,
    playSound: playPresentationSound,
    playSoundAndWait: playPresentationSoundAndWait,
    showTableAction: transientEvents.showTableAction,
    structuralMeldCount: (playerIndex) => structuralMeldCount(state.players[playerIndex]),
    getRoundLabel: () => selectors.roundLabel.value,
    ruleset,
    getThemeName: getTableThemeName,
    animeFixedTts,
    // 房主权威无头引擎的 AI 身份由在线 runtime 管理；不得读取单机全局语音注册表。
    isLlmVoiceSeat: headless ? () => false : undefined,
    announceLlmRoundReactions: headless ? () => undefined : undefined,
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
        themeName: getTableThemeName(),
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
    wait: openingInstant ? async () => {} : scheduler.wait,
    later: scheduler.later,
    playSound: playPresentationSound,
    playSoundAndWait: openingInstant ? async () => {} : playPresentationSoundAndWait,
    announce: transientEvents.announce,
    getRoundLabel: () => selectors.roundLabel.value,
    beginTurn,
    endGame,
    playerSeeds: aiPlayerSeeds,
    humanPlayerSeed,
    // P1 §6：重跑参数（环状牌墙 + 开局骰子 + 庄家 + 牌山断点）在"发牌之前、骰子已定"那一刻交出。
    // 广麻没有翻精 ⇒ 这里比翻精癞子少一整套参数（没有翻精墩/开牌断点重排）。
    onRoundPrepared: (info) => safely('opening-parameters', () => {
      // 牌墙口径自检：不是 136 张 / 不是每种 4 张就**留痕**，但**不拦**对局 ——
      // 记录侧的问题只应该让这一场不完整，绝不能影响正在打的牌（§9.5）。
      const problems = ringWallDeficiencies(info.ringWall, TILE_TYPES)
      if (problems.length) {
        analysis?.noteGap({ scope: 'reproduction', reason: `ring-wall-unexpected: ${problems.join('、')}` })
      }
      analysisRoundRing = {
        ringWall: [...info.ringWall],
        firstDice: [...info.openingDice] as [number, number],
        dealer: info.dealer,
        wallBreakIndex: info.wallBreakIndex,
        // 当局开局分在**发牌之前**读到的这一份（时间线在拆墙那一刻交出）：重跑要靠它从同一分起步，
        // 少了它第 2 局以后的结束分数永远对不上。
        openingScores: [...info.openingScores],
      }
    }),
  })
  // 每局开局先复位跟庄窗口，再走开局时间线。
  const startGame = (mode?: Parameters<typeof openingTimeline.start>[0], options?: GameStartOptions & { waitForOpeningReady?: () => Promise<void> }) => {
    animeFixedTts?.reset()
    followDealer.reset()
// 传了 mode 就是**新的一场**（nextRound 走的是不带 mode 的那条路）：本局序号与结算去重都要
    // 从头开始，否则第二场的 roundId 会接着上一场继续涨、与展示回放的"已打局数"对不上。
    if (mode) {
      analysisRoundIndex = 0
      // 新的一场：上一场残留的复现快照/命令日志一律作废（上半场已随局末落库）。
      analysisRoundRing = null
      analysisRoundOpening = null
      analysisRoundCommands.length = 0
      analysisSettledResult = null
    }
    // 转交开局参数（固定牌墙/骰子/庄家/开局分）。此前第二个参数被丢掉 ⇒ 只有本引擎做不到
    // "同一副牌重跑两次"，而 §3.3 的交叉校验（拿记录里的牌墙+骰子重新发牌、比对 `postDealHands`）
    // 正需要它。现有调用方都只传一个参数，因此行为不变。
    // vibehub 侧另有联机层要的 `waitForOpeningReady` 注入，一并保留。
    return openingTimeline.start(mode, {
      ...options,
      waitForOpeningReady: options?.waitForOpeningReady ?? waitForOpeningReady,
    })
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

  // ── 分析记录：中途退出（局书号、结算流水与局边界的两个 watch 在下面） ──
  if (analysis) {
    // 局中分数流动（跟庄/杠分）：经典玩法没有权威账本，按**分数实际变化**折算，每次变化一条。
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

  /**
   * 局末结算折算（§5）。
   *
   * 职责与 `analysisFlushScores` 分开：那个记**局中**的分数流动（跟庄/杠分），本函数**兜底**记
   * "本局结束了，但整局分数一次都没变过"那种情况（典型是荒庄：`endDraw` 的罚符恰好四家相抵）。
   * 为什么需要这条兜底：P1 要拿记录侧的结束状态去比重跑的结束分数，而**每条结算是按分数变化记的**——
   * 一次变化都没有的局就一条记录都没有，那一局于是"无从比对"。让它空着等于把"没记"伪装成"缺数据"。
   *
   * 分工否则会重复记：若本局有过分数变化，`analysisFlushScores` 的末次读数就是局末分，
   * 这里发现"没有任何变化"就什么也不写（同一次结束绝不落两条流水）。
   * 时间上成立：引擎的分数写入（`finalizeWin` 与 `endDraw`）都发生在 `state.result` 落定**之前**
   * （见 `settlementTimeline`），而分数 watch 推给 `analysisFlushScores` 的是一次**微任务**——
   * 本函数在 `state.result` 的同步 watch 里跑，看到的是"局末分 vs 上一次读数"的原始差别。
   */
  function recordAnalysisSettlement() {
    if (!analysis || analysisRoundSettled) return
    analysisRoundSettled = true
    // 局都结束了，还挂着的回执不会再有"下一个窗口"来收尾（§3.2 的 pending 语义）。
    analysisPending.clear()
    const endingScores = state.players.map((player) => player.score)
    // 本局分数有过变化 ⇒ `analysisFlushScores` 已经记过（或马上会记）局末那一段，这里不再重复。
    if (endingScores.some((score, seat) => score !== (analysisLastScores[seat] ?? 0))) return
    if (analysisOpeningScores.length !== endingScores.length) return
    analysisSettlementSeq += 1
    try {
      analysis.settlement(settlementsFromScoreChange({
        roundIndex: analysisRoundIndex,
        roundId: String(analysisRoundIndex),
        before: [...analysisOpeningScores],
        after: endingScores,
        kind: analysisRoundEndKind ?? roundKindOfResult(state.result.value),
        sourceEventId: `round-${analysisRoundIndex}`,
      }))
    } catch { /* 记录失败不影响对局 */ }
    analysisRoundEndKind = null
  }

  /**
   * P1 §6：`beginTurn` 那一刻的复现快照（每局一次）。
   *
   * 取的是"**发牌完成、还没到第一手决策**"的读数：四家手牌（交叉校验用）、当局开局分
   * （结束分数的比对基准）。重跑**输入**（环状牌墙/骰子/庄家）另由开局时间线的
   * `onRoundPrepared` 交出 —— 它们在发牌前就定型了，且牌墙发完就没了。
   *
   * 广麻**没有翻精** ⇒ 这里**没有** `flipTile`/`jokers`/`flipSeat`/`flipStack` 四项。
   * 这不是漏取：`localOpeningTimeline` 里根本没有 `resolveFlip` 那套推算，补空值是编造。
   */
  function captureAnalysisOpening() {
    if (!analysis || analysisRoundOpening) return
    safely('opening-snapshot', () => {
      analysisRoundOpening = {
        roundIndex: analysisRoundIndex,
        postDealHands: state.players.map((player) => [...player.hand]),
      }
    })
  }

  /**
   * P1 §6：局末把这一局的**复现数据**落库，然后作废本局的快照与命令日志。
   *
   * 快照缺失时（例如开局四红直接结算：开局时间线直接 `endGame`，根本没走到 `beginTurn`）
   * **不写**这一局，只如实留痕 —— 拿局末状态凑一个"起始状态"出来是另一种谎（§9.5）。
   */
  function recordAnalysisReproduction() {
    if (!analysis) return
    const ring = analysisRoundRing
    const opening = analysisRoundOpening
    if (!ring || !opening) {
      safely('reproduction-gap', () => analysis?.noteGap({
        scope: 'reproduction',
        reason: ring ? 'round-without-opening-snapshot' : 'round-without-opening-parameters',
      }))
    } else {
      safely('reproduction', () => analysis?.reproduction(buildLotusClassicReproduction({
        roundIndex: opening.roundIndex,
        ringWall: ring.ringWall,
        // 广麻只掷一次骰 ⇒ 只有 `dice.first`，没有 `dice.second`（翻精癞子才有第二次掷骰）。
        dice: { first: ring.firstDice },
        dealer: ring.dealer,
        openingScores: ring.openingScores,
        postDealHands: opening.postDealHands,
        wallBreakIndex: ring.wallBreakIndex,
        commands: analysisRoundCommands,
      })))
    }
    analysisRoundOpening = null
    analysisRoundCommands.length = 0
  }

  // 分析记录的两个局边界，都用 sync 刷新 —— 必须与"局边界"同一拍发生：
  // 开局分数若晚一拍取，第 2 局以后就会取到上一局结算后的值（§5 的 openingScores 正为此必须记）。
  watch(state.phase, (phase) => {
    if (phase !== 'opening') return
    // 连庄也算新的一局（"已打局数 + 1"），所以序号在这里加一，与展示回放同一套口径。
    analysisRoundIndex += 1
    analysisOpeningScores = state.players.map((player) => player.score)
    // 注意**不能**在这里把 `analysisLastScores` 重置成开局分：它是**跨局**首尾相接的读数
    // （结算流水"相邻两条 before 与上一条 scoresAfter 一致"这条判据靠它），
    // 重置会让局末那条兜底结算与上一条流水对不上。
    analysisRoundSettled = false
    analysisRoundEndKind = null
    // 窗口 ID 的计数器是"本局内第 N 次进入决策"（§3.1），所以每局从 1 重新开始。
    analysisWindowSeq = 0
    analysisPending.clear()
    // P1 §6：新的一局 ⇒ 上一局的复现快照与命令日志作废（它们已在上一局局末落库）。
    // 注意**不能**在这里清 `analysisRoundRing`：重跑参数在 `onRoundPrepared` 里、本拍之前就交出来了。
    analysisRoundOpening = null
    analysisRoundCommands.length = 0
  }, { flush: 'sync' })
  watch(state.result, (result) => {
    // 用对象身份去重：同一局的结算对象只会被折算一次；换局/换场都是新对象。
    if (!result || result === analysisSettledResult) return
    analysisSettledResult = result
    // 本局结束的类型（自摸/点杠/抢杠/荒庄）：**先**写下，结算折算要用它当 `kind`。
    analysisRoundEndKind = roundKindOfResult(result)
    recordAnalysisSettlement()
    // P1 §6：复现数据也在这里落库（此刻分数已算完 —— 见 `settlementTimeline` 里
    // `finalizeWin`/`endDraw` 把分数写入放在 `state.result` 之前的顺序）。
    recordAnalysisReproduction()
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
    wallBreakIndex: state.wallBreakIndex,
    userCurrentWaits: selectors.userCurrentWaits,
    userTingOptions: selectors.userTingOptions,
    userDiscardWaits: selectors.userDiscardWaits,
    userKongs: selectors.userKongs,
capabilities: computed(() => ({
      // 经典莲花广麻没有翻精，但仍需把拆墙断点暴露给牌桌和房主快照。
      lotusTable: {
        flipTile: null,
        jokerTiles: [],
        wildcardTiles: [],
        wallBreakIndex: state.wallBreakIndex.value,
        flipStack: null,
      },
      // P1 §6 的重跑校验器要读"由牌墙 + 骰子 + 庄家推出的开牌断点"（交叉校验用）。
      // 广麻没有翻精：**只有这一项**，没有精牌/方位/墩位那一套。
      openingWallBreakIndex: () => state.wallBreakIndex.value,
    })),
    startGame,
    ...playerActions,
    ...matchLifecycle,
    tileName,
    ...debugScenarios,
    humanController,
    replaceAiControllers,
  })
}
