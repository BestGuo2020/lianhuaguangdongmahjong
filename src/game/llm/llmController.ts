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
import { requestLlmDecision } from './client'
import type { LlmProviderConfig } from './config'
import type { CanonicalAction } from './schema'
import type { LlmSpeechPriority } from './speechPolicy'
import { decisionSpeech } from './decisionSpeech'

export interface LlmControllerStats {
  requests: number
  successes: number
  fallbacks: number
  messages: number
  invalidActions: number
}

export function createLlmStats(): LlmControllerStats {
  return { requests: 0, successes: 0, fallbacks: 0, messages: 0, invalidActions: 0 }
}

export interface LlmControllerHooks {
  /** message 为纯展示文本（牌桌气泡/设置面板日志）：展示失败不影响动作执行（§7.4）。
   * seat 为说话者的座位绝对索引。 */
  onLlmMessage?(seat: number, text: string, meta?: LlmMessageMeta): void | Promise<void>
  onReset?(): void
}

export interface LlmMessageMeta {
  priority: LlmSpeechPriority
  decision?: DecisionInput['decision']
  actionKind?: CanonicalAction['kind']
  source?: 'decision' | 'win'
}

const IMPORTANT_SPEECH_ACTIONS = new Set<CanonicalAction['kind']>([
  'gang', 'peng', 'chi', 'added-kong', 'concealed-kong', 'wind-kong',
])

/** 内部：LLM 决定 → 候选动作；失败/非法 → null（回退）。 */
async function decideCanonical(
  config: LlmProviderConfig,
  input: DecisionInput,
  hooks: LlmControllerHooks,
  stats: LlmControllerStats,
): Promise<CanonicalAction | null> {
  const built = buildDecisionRequest(input)
  if (!built.request) return built.fallbackAction
  if (built.request.candidates.length <= 1) return built.fallbackAction
  const ids = built.request.candidates.map((candidate) => candidate.id)
  const prompt = buildPrompt(config.style, built.request)
  stats.requests += 1
  try {
    const output = await requestLlmDecision({ config, messages: prompt, candidateIds: ids })
    const candidate = built.request.candidates.find((item) => item.id === output.choice)
    if (!candidate) {
      stats.fallbacks += 1
      return built.fallbackAction
    }
    // 自校验（§8）：对照当前 ctx 复核合法性；任何越界/不满足 → 回退（引擎执行层还会再复核一次）
    if (!isActionLegal(input, candidate.action)) {
      stats.invalidActions += 1
      return built.fallbackAction
    }
    // 模型只决定 choice；台词在动作合法性确认后由程序生成，杜绝“说留着却打出”等矛盾。
    const speech = decisionSpeech(candidate.action, config.style, stats.messages)
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
    return built.fallbackAction
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
  } satisfies Pick<DecisionInput, 'playerIndex' | 'scores' | 'peers' | 'seatWind' | 'roundWind' | 'dealerIndex' | 'roundIndex' | 'requestId' | 'stateVersion' | 'visibleTiles' | 'publicTiles' | 'upperLastDiscard' | 'earlyRound' | 'wallCount' | 'jokerTiles' | 'wildcardTiles'>
}

/** 广麻（lotus-classic）LLM 控制器。 */
export class CoreLlmController implements PlayerController {
  private readonly fallback: AiController

  constructor(
    private readonly config: LlmProviderConfig,
    private readonly hooks: LlmControllerHooks = {},
    readonly stats: LlmControllerStats = createLlmStats(),
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
    }, this.hooks, this.stats)
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
    }, this.hooks, this.stats)
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
    }, this.hooks, this.stats)
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
    }, this.hooks, this.stats)
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
    }, this.hooks, this.stats)
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
