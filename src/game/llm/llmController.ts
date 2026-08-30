// LLM 控制器（适配器）—— docs/llm-ai-design.md §2/§3/§8。
// 两个实现：CoreLlmController（广麻，PlayerController）与 LotusLlmController（莲花，LotusController）。
// 铁律：胡/抢杠引擎短路由（v1 不放给 LLM）；skipDraw 只允许出牌；
// 任何失败（超时/网络/HTTP/解析/重试后仍非法）回退确定性启发式；动作执行前自校验合法性。
import {
  AiController,
  type ClaimAction,
  type ClaimContext,
  type PlayerController,
  type RobKongContext,
  type TurnAction,
  type TurnContext,
} from '../core/controllers/playerController'
import {
  LotusAiController,
  type LotusChiAction,
  type LotusChiContext,
  type LotusClaimAction,
  type LotusClaimContext,
  type LotusController,
  type LotusHuAction,
  type LotusHuContext,
  type LotusRobKongAction,
  type LotusRobKongContext,
  type LotusTurnAction,
  type LotusTurnContext,
} from '../variants/lotus/lotusControllers'
import { decideRobKong as lotusDecideRobKong } from '../variants/lotus/lotusAi'
import { LOTUS_RULESET, type ChiMeld } from '../variants/lotus/lotusRules'
import { hasReadyDiscard, projectKongBloom } from '../variants/lotus/kongProjection'
import { decideRobKong as coreDecideRobKong } from '../core/controllers/ai'
import { DEFAULT_RULESET } from '../core/rules/ruleset'
import type { TileType } from '../core/contracts/types'
import { buildDecisionRequest, protectedDiscardTiles, type DecisionInput } from './candidates'
import { buildPrompt } from './prompt'
import { isConditionalReasoningSuppressed, requestLlmDecision } from './client'
import type { LlmProviderConfig } from './config'
import type { CanonicalAction, StateSnapshotV1 } from './schema'
import type { LlmSpeechPriority } from './speechPolicy'
import { resolveDecisionSpeech, type DecisionSpeechFacts } from './decisionSpeech'
import { ConditionalReasoningCoordinator } from './conditionalReasoning'
import { resolveReasoningPolicy } from './reasoningPolicy'

export interface LlmControllerStats {
  requests: number
  successes: number
  fallbacks: number
  messages: number
  invalidActions: number
  /** 条件深思次数；旧分支统计汇总未提供时按 0 展示。 */
  reasoningRequests?: number
  /** 实际发生思考的请求数（含 always-on 低强度与代理返回的推理流）。 */
  thinkingRequests?: number
  /** 命中统一触发器后从关闭/低强度升级的请求数。 */
  enhancedReasoningRequests?: number
}

export function createLlmStats(): LlmControllerStats {
  return {
    requests: 0, successes: 0, fallbacks: 0, messages: 0, invalidActions: 0,
    reasoningRequests: 0, thinkingRequests: 0, enhancedReasoningRequests: 0,
  }
}

export interface LlmControllerHooks {
  /** message 为纯展示文本（牌桌气泡/设置面板日志）：展示失败不影响动作执行（§7.4）。
   * seat 为说话者的座位绝对索引。 */
  onLlmMessage?(seat: number, text: string, meta?: LlmMessageMeta): void | Promise<void>
  /** LLM 失败转交引擎时的纯气泡事件；表现层需走发言频率但不得合成 TTS。 */
  onLlmFallback?(seat: number, meta: LlmMessageMeta): void | Promise<void>
  /** 深度思考仅展示客户端生成的安全进度，不接收原始推理文本。 */
  onLlmStatus?(seat: number, active: boolean, text?: string): void | Promise<void>
  onReset?(): void
}

export interface LlmMessageMeta {
  priority: LlmSpeechPriority
  decision?: DecisionInput['decision']
  actionKind?: CanonicalAction['kind']
  source?: 'decision' | 'win' | 'fallback'
}

const IMPORTANT_SPEECH_ACTIONS = new Set<CanonicalAction['kind']>([
  'gang', 'peng', 'chi', 'added-kong', 'concealed-kong', 'wind-kong',
])

const SAFE_REASONING_STAGES = [
  '正在观察公开牌局',
  '正在整理规则约束',
  '正在比较可行动作',
  '正在评估攻守节奏',
  '正在复核最终选择',
] as const
/** 只由推理块序号生成，不接触暗手、候选或供应商原始推理内容。 */
export function safeReasoningStatus(sequence: number): string {
  const count = Math.max(1, Math.floor(sequence))
  return `思考中 · ${SAFE_REASONING_STAGES[(count - 1) % SAFE_REASONING_STAGES.length]}`
}

function speechFacts(state: StateSnapshotV1, action: CanonicalAction): DecisionSpeechFacts {
  const meldTypes = (name: 'upper' | 'opposite' | 'lower') => state.snapshots[name].melds.map((meld) => meld.type)
  return {
    isDealer: state.isDealer,
    publicMeldTypes: {
      上家: meldTypes('upper'), 对家: meldTypes('opposite'), 下家: meldTypes('lower'),
    },
    currentDiscard: state.claimTile && state.claimFrom
      ? { from: state.claimFrom, tile: state.claimTile }
      : null,
    discardedTile: action.kind === 'discard' ? state.hand[action.handIndex] : undefined,
    concealedTiles: state.hand,
  }
}

/** 内部：LLM 决定 → 候选动作；失败/非法 → null（回退）。 */
async function decideCanonical(
  config: LlmProviderConfig,
  input: DecisionInput,
  hooks: LlmControllerHooks,
  stats: LlmControllerStats,
  reasoning: ConditionalReasoningCoordinator,
): Promise<CanonicalAction | null> {
  const built = buildDecisionRequest(input)
  if (!built.request) return built.fallbackAction
  if (built.request.candidates.length <= 1) return built.fallbackAction
  const notifyFallback = async () => {
    const action = built.fallbackAction
    if (!action) return
    try {
      await hooks.onLlmFallback?.(input.playerIndex, {
        priority: IMPORTANT_SPEECH_ACTIONS.has(action.kind) ? 'important' : 'normal',
        decision: input.decision,
        actionKind: action.kind,
        source: 'fallback',
      })
    } catch { /* 回退提示不影响引擎动作 */ }
  }
  const ids = built.request.candidates.map((candidate) => candidate.id)
  const prompt = buildPrompt(config.style, built.request)
  const requestedReasoningPolicy = resolveReasoningPolicy(config, true)
  const alwaysThinking = requestedReasoningPolicy.mode === 'always-on'
  const supportsReasoning = (requestedReasoningPolicy.mode === 'explicit-on' || alwaysThinking)
    && !isConditionalReasoningSuppressed(config)
  // 当前游戏循环没有更短的外部倒计时；条件深思拥有独立的 45 秒总预算（40 秒请求 + 余量）。
  const trigger = supportsReasoning
    ? reasoning.admit(built.request, input.playerIndex, reasoning.config.minRemainingBudgetMs)
    : { enabled: false }
  const useReasoning = trigger.enabled
  let reasoningProgressSequence = 0
  // always-on 的普通 low 请求不先播思考台词；收到流式推理块后仍展示安全进度气泡。
  let reasoningStatusActive = useReasoning
  let thinkingCounted = false
  const countThinking = () => {
    if (thinkingCounted) return
    thinkingCounted = true
    stats.thinkingRequests = (stats.thinkingRequests ?? 0) + 1
  }
  const onReasoningProgress = () => {
    countThinking()
    reasoningProgressSequence += 1
    reasoningStatusActive = true
    try {
      void hooks.onLlmStatus?.(
        input.playerIndex,
        true,
        safeReasoningStatus(reasoningProgressSequence),
      )
    } catch { /* 展示失败不影响决策 */ }
  }
  stats.requests += 1
  if (alwaysThinking) countThinking()
  if (useReasoning) {
    stats.reasoningRequests = (stats.reasoningRequests ?? 0) + 1
    stats.enhancedReasoningRequests = (stats.enhancedReasoningRequests ?? 0) + 1
    countThinking()
  }
  if (reasoningStatusActive) {
    try { await hooks.onLlmStatus?.(input.playerIndex, true) } catch { /* 状态气泡不影响决策 */ }
  }
  try {
    const output = await requestLlmDecision({
      config, messages: prompt, candidateIds: ids,
      reasoning: useReasoning,
      deadlineMs: useReasoning ? reasoning.config.deadlineMs : undefined,
      onReasoningProgress,
    })
    const candidate = built.request.candidates.find((item) => item.id === output.choice)
    if (!candidate) {
      stats.fallbacks += 1
      await notifyFallback()
      return built.fallbackAction
    }
    // 自校验（§8）：对照当前 ctx 复核合法性；任何越界/不满足 → 回退（引擎执行层还会再复核一次）
    if (!isActionLegal(input, candidate.action)) {
      stats.invalidActions += 1
      stats.fallbacks += 1
      await notifyFallback()
      return built.fallbackAction
    }
    // choice 决定真实动作；message 是牌桌闲聊/烟雾弹，不要求“言而有信”。
    // 仅在缺失或含幕后词时回退动作一致的程序台词。
    const speech = resolveDecisionSpeech(
      output.message,
      candidate.action,
      config.style,
      stats.messages,
      speechFacts(built.request.state, candidate.action),
    )
    stats.messages += 1
    try {
      await hooks.onLlmMessage?.(input.playerIndex, speech, {
        priority: IMPORTANT_SPEECH_ACTIONS.has(candidate.action.kind) ? 'important' : 'normal',
        decision: input.decision,
        actionKind: candidate.action.kind,
        source: 'decision',
      })
    } catch {
      // 气泡/TTS 是表现层；失败时仍执行已经通过合法性校验的模型动作。
    }
    stats.successes += 1
    return candidate.action
  } catch {
    stats.fallbacks += 1
    await notifyFallback()
    return built.fallbackAction
  } finally {
    if (reasoningStatusActive) {
      try { await hooks.onLlmStatus?.(input.playerIndex, false) } catch { /* 状态气泡不影响决策 */ }
    }
  }
}

/** 动作合法性复核（§8.2 表，控制器侧；引擎执行层仍有二次验牌）。 */
export function isActionLegal(input: DecisionInput, action: CanonicalAction): boolean {
  const { hand } = input
  if (action.kind === 'discard') {
    if (!Number.isInteger(action.handIndex) || action.handIndex < 0 || action.handIndex >= hand.length) return false
    const protectedTiles = protectedDiscardTiles(input)
    return !(protectedTiles.has(hand[action.handIndex]) && hand.some((tile) => !protectedTiles.has(tile)))
  }
  if (action.kind === 'added-kong') {
    const meld = input.melds[action.meldIndex]
    return Boolean(meld) && meld.type === 'peng' && hand.includes(meld.tile)
  }
  if (action.kind === 'concealed-kong') {
    const kongs = input.ruleCode === 'lotus-legacy'
      ? LOTUS_RULESET.win.concealedKongs(hand, { jokers: input.jokerTiles ?? [] })
      : DEFAULT_RULESET.win.concealedKongs(hand)
    if (!kongs.includes(action.tile)) return false
    if (input.ruleCode !== 'lotus-legacy') return true
    const jokers = input.jokerTiles ?? []
    const guaranteed = projectKongBloom({
      kind: 'concealed-kong', hand, exposedMelds: input.exposedMelds,
      jokers, tile: action.tile, visibleTiles: input.visibleTiles,
    }).guaranteedKongBloom
    return guaranteed || !hasReadyDiscard(hand, input.exposedMelds, jokers)
  }
  if (action.kind === 'wind-kong') {
    if (input.ruleCode !== 'lotus-legacy' || !windKongInternal(hand)) return false
    const jokers = input.jokerTiles ?? []
    const guaranteed = projectKongBloom({
      kind: 'wind-kong', hand, exposedMelds: input.exposedMelds,
      jokers, visibleTiles: input.visibleTiles,
    }).guaranteedKongBloom
    return guaranteed || !hasReadyDiscard(hand, input.exposedMelds, jokers)
  }
  if (action.kind === 'gang') return (input.canGang ?? false) === true
  if (action.kind === 'peng') return (input.canPeng ?? false) === true
  if (action.kind === 'chi') {
    return Number.isInteger(action.optionIndex)
      && action.optionIndex >= 0
      && (input.chiOptions?.length ?? 0) > action.optionIndex
  }
  if (action.kind === 'pass') return true
  // win 由引擎短路产生，不通过 LLM 候选：这里拒绝
  return false
}

function windKongInternal(hand: TileType[]): boolean {
  // 莲花乱风杠：东南西北各 ≥1（精按自身风牌面使用）
  const winds: TileType[] = ['east', 'south', 'west', 'north']
  return winds.every((wind) => hand.includes(wind))
}

/** 上下文元数据最小形状（core/lotus/chi 三个上下文共读字段）。 */
interface LlmMetaLike {
  playerIndex?: number
  scores?: number[]
  peers?: Array<{ discards: TileType[]; melds: Array<{ type: string; tile: TileType; tiles: TileType[] }> }>
  seatWind?: string
  roundWind?: string
  dealerIndex?: number
  roundIndex?: number
  requestId?: string
  stateVersion?: string
  visibleTiles?: TileType[]
  publicTiles?: TileType[]
  upperLastDiscard?: TileType | null
  earlyRound?: boolean
  wallCount?: number
  jokerTiles?: TileType[]
  wildcardTiles?: TileType[]
  turnOrigin?: DecisionInput['turnOrigin']
  drawnTile?: TileType | null
}

/** metaOf 返回：除调用方显式提供的字段外，全部可选项。 */
type DecisionMeta = Omit<DecisionInput, 'ruleCode' | 'decision' | 'hand' | 'melds' | 'exposedMelds'>

function metaOf(input: LlmMetaLike): DecisionMeta {
  return {
    playerIndex: input.playerIndex ?? 0,
    scores: input.scores,
    peers: input.peers,
    seatWind: input.seatWind,
    roundWind: input.roundWind,
    dealerIndex: input.dealerIndex,
    roundIndex: input.roundIndex,
    requestId: input.requestId,
    stateVersion: input.stateVersion,
    visibleTiles: input.visibleTiles,
    publicTiles: input.publicTiles,
    upperLastDiscard: input.upperLastDiscard,
    earlyRound: input.earlyRound,
    wallCount: input.wallCount,
    jokerTiles: input.jokerTiles,
    wildcardTiles: input.wildcardTiles,
    turnOrigin: input.turnOrigin,
    drawnTile: input.drawnTile,
  } satisfies Pick<DecisionInput, 'playerIndex' | 'scores' | 'peers' | 'seatWind' | 'roundWind' | 'dealerIndex' | 'roundIndex' | 'requestId' | 'stateVersion' | 'visibleTiles' | 'publicTiles' | 'upperLastDiscard' | 'earlyRound' | 'wallCount' | 'jokerTiles' | 'wildcardTiles' | 'turnOrigin' | 'drawnTile'>
}

/** 广麻（lotus-classic）LLM 控制器。 */
export class CoreLlmController implements PlayerController {
  private readonly fallback: AiController

  constructor(
    private readonly config: LlmProviderConfig,
    private readonly hooks: LlmControllerHooks = {},
    readonly stats: LlmControllerStats = createLlmStats(),
    private readonly reasoning = new ConditionalReasoningCoordinator(),
  ) {
    this.fallback = new AiController({ turn: 0, afterKong: 0, claim: 0 }, (fn) => fn())
  }

  async requestTurn(ctx: TurnContext): Promise<TurnAction> {
    // v1 胡短路：引擎判定，不放给 LLM（§3）
    const ruleset = ctx.ruleset ?? DEFAULT_RULESET
    if (!ctx.skipDraw && ruleset.win.isWinningHand(ctx.hand, ctx.exposedMelds)) return { kind: 'win' }
    const action = await decideCanonical(this.config, {
      ruleCode: 'lotus-classic',
      decision: 'turn',
      playerIndex: ctx.playerIndex ?? 0,
      hand: ctx.hand,
      melds: ctx.melds,
      exposedMelds: ctx.exposedMelds,
      kongBloom: ctx.kongBloom,
      skipDraw: ctx.skipDraw,
      ...metaOf(ctx),
    }, this.hooks, this.stats, this.reasoning)
    if (action === null) return this.fallback.requestTurn(ctx)
    return mapTurnAction(action)
  }

  async requestClaim(ctx: ClaimContext): Promise<ClaimAction> {
    if (!ctx.canPeng && !ctx.canGang) return { kind: 'pass' }
    const action = await decideCanonical(this.config, {
      ruleCode: 'lotus-classic',
      decision: 'claim',
      playerIndex: ctx.playerIndex ?? 0,
      hand: ctx.hand,
      melds: [],
      exposedMelds: ctx.exposedMelds ?? 0,
      canPeng: ctx.canPeng,
      canGang: ctx.canGang,
      tile: ctx.tile,
      from: ctx.from,
      ...metaOf(ctx),
    }, this.hooks, this.stats, this.reasoning)
    if (action === null) return this.fallback.requestClaim(ctx)
    if (action.kind === 'gang') return { kind: 'gang' }
    if (action.kind === 'peng') return { kind: 'peng' } // §4.3：不带 discardIndex，两步决策
    return { kind: 'pass' }
  }

  async requestRobKong(ctx: RobKongContext): Promise<'win' | 'pass'> {
    return coreDecideRobKong({ hand: ctx.hand, exposedMelds: ctx.exposedMelds, tile: ctx.tile, from: ctx.from })
  }

  onDiscarded(): void {}
  reset(): void { this.hooks.onReset?.() }
}

/** 莲花麻将（lotus-legacy）LLM 控制器。 */
export class LotusLlmController implements LotusController {
  private readonly fallback: LotusAiController

  constructor(
    private readonly config: LlmProviderConfig,
    private readonly hooks: LlmControllerHooks = {},
    readonly stats: LlmControllerStats = createLlmStats(),
    private readonly reasoning = new ConditionalReasoningCoordinator(),
  ) {
    this.fallback = new LotusAiController({ turn: 0, afterKong: 0, claim: 0 }, (fn) => fn())
  }

  async requestTurn(ctx: LotusTurnContext): Promise<LotusTurnAction> {
    if (!ctx.skipDraw) {
      for (const tile of LOTUS_RULESET.win.concealedKongs(ctx.hand, { jokers: ctx.jokers })) {
        if (projectKongBloom({
          kind: 'concealed-kong', hand: ctx.hand, exposedMelds: ctx.exposedMelds,
          jokers: ctx.jokers, tile, visibleTiles: ctx.visibleTiles,
        }).guaranteedKongBloom) return { kind: 'concealed-kong', tile }
      }
      if (projectKongBloom({
        kind: 'wind-kong', hand: ctx.hand, exposedMelds: ctx.exposedMelds,
        jokers: ctx.jokers, visibleTiles: ctx.visibleTiles,
      }).guaranteedKongBloom) return { kind: 'wind-kong' }
    }
    if (!ctx.skipDraw && LOTUS_RULESET.win.isWinningHand(ctx.hand, ctx.exposedMelds, { jokers: ctx.jokers })) {
      return { kind: 'win' }
    }
    const action = await decideCanonical(this.config, {
      ruleCode: 'lotus-legacy',
      decision: 'turn',
      playerIndex: ctx.playerIndex ?? 0,
      hand: ctx.hand,
      melds: ctx.melds,
      exposedMelds: ctx.exposedMelds,
      kongBloom: ctx.kongBloom,
      skipDraw: ctx.skipDraw,
      jokerTiles: ctx.jokerTiles ?? ctx.jokers,
      wildcardTiles: ctx.wildcardTiles,
      ...metaOf(ctx),
    }, this.hooks, this.stats, this.reasoning)
    if (action === null) return this.fallback.requestTurn(ctx)
    return mapLotusTurnAction(action)
  }

  async requestDiscardHu(ctx: LotusHuContext): Promise<LotusHuAction> {
    if (ctx.canGang && projectKongBloom({
      kind: 'discard-gang', hand: ctx.hand, exposedMelds: ctx.exposedMelds,
      jokers: ctx.jokers, tile: ctx.tile, visibleTiles: ctx.visibleTiles,
    }).guaranteedKongBloom) return { kind: 'gang' }
    // v1：点炮胡引擎短路（§3）
    const ordinaryJokers = (ctx.jokers.includes(ctx.tile) || ctx.tile === 'white') ? [ctx.tile] : []
    return LOTUS_RULESET.win.isWinningHand(
      [...ctx.hand, ctx.tile],
      ctx.exposedMelds,
      { jokers: ctx.jokers, ordinaryJokers, jokerSubstitutes: ['white'] },
    ) ? { kind: 'win' } : { kind: 'pass' }
  }

  async requestClaim(ctx: LotusClaimContext): Promise<LotusClaimAction> {
    if (!ctx.canPeng && !ctx.canGang && !ctx.chiOptions.length) return { kind: 'pass' }
    if (ctx.canGang && projectKongBloom({
      kind: 'discard-gang', hand: ctx.hand, exposedMelds: ctx.exposedMelds,
      jokers: ctx.jokers, tile: ctx.tile, visibleTiles: ctx.visibleTiles,
    }).guaranteedKongBloom) return { kind: 'gang' }
    const action = await decideCanonical(this.config, {
      ruleCode: 'lotus-legacy',
      decision: 'claim',
      playerIndex: ctx.playerIndex ?? 0,
      hand: ctx.hand,
      melds: [],
      exposedMelds: ctx.exposedMelds,
      canPeng: ctx.canPeng,
      canGang: ctx.canGang,
      chiOptions: ctx.chiOptions,
      tile: ctx.tile,
      from: ctx.from,
      jokerTiles: ctx.jokerTiles ?? ctx.jokers,
      wildcardTiles: ctx.wildcardTiles,
      ...metaOf(ctx),
    }, this.hooks, this.stats, this.reasoning)
    if (action === null) return this.fallback.requestClaim(ctx)
    return mapLotusClaimAction(action, ctx.chiOptions)
  }

  async requestChi(ctx: LotusChiContext): Promise<LotusChiAction> {
    if (!ctx.chiOptions.length) return { kind: 'pass' }
    const action = await decideCanonical(this.config, {
      ruleCode: 'lotus-legacy',
      decision: 'claim',
      playerIndex: ctx.playerIndex ?? 0,
      hand: ctx.hand,
      melds: [],
      exposedMelds: 0,
      chiOptions: ctx.chiOptions,
      tile: ctx.tile,
      from: ctx.from,
      jokerTiles: ctx.jokerTiles ?? ctx.jokers,
      wildcardTiles: ctx.wildcardTiles,
      ...metaOf(ctx),
    }, this.hooks, this.stats, this.reasoning)
    if (action === null) return this.fallback.requestChi(ctx)
    if (action.kind === 'chi') return { kind: 'chi', meld: ctx.chiOptions[action.optionIndex] }
    return { kind: 'pass' }
  }

  async requestRobKong(ctx: LotusRobKongContext): Promise<LotusRobKongAction> {
    return lotusDecideRobKong({ hand: ctx.hand, exposedMelds: ctx.exposedMelds, tile: ctx.tile, from: ctx.from, jokers: ctx.jokers })
  }

  onDiscarded(): void {}
  reset(): void { this.hooks.onReset?.() }
}

function mapTurnAction(action: CanonicalAction): TurnAction {
  switch (action.kind) {
    case 'win': return { kind: 'win' }
    case 'added-kong': return { kind: 'added-kong', meldIndex: action.meldIndex }
    case 'concealed-kong': return { kind: 'concealed-kong', tile: action.tile }
    case 'discard': return { kind: 'discard', handIndex: action.handIndex }
    default: return { kind: 'discard', handIndex: 0 }
  }
}

function mapLotusTurnAction(action: CanonicalAction): LotusTurnAction {
  switch (action.kind) {
    case 'win': return { kind: 'win' }
    case 'added-kong': return { kind: 'added-kong', meldIndex: action.meldIndex }
    case 'concealed-kong': return { kind: 'concealed-kong', tile: action.tile }
    case 'wind-kong': return { kind: 'wind-kong' }
    case 'discard': return { kind: 'discard', handIndex: action.handIndex }
    default: return { kind: 'discard', handIndex: 0 }
  }
}

function mapLotusClaimAction(action: CanonicalAction, chiOptions: ChiMeld[]): LotusClaimAction {
  switch (action.kind) {
    case 'gang': return { kind: 'gang' }
    case 'peng': return { kind: 'peng' } // §4.3：两步决策，不带 discardIndex
    case 'chi': return { kind: 'chi', meld: chiOptions[action.optionIndex] ?? chiOptions[0] }
    default: return { kind: 'pass' }
  }
}
