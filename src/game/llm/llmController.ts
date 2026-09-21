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
import { requestPreparedDecision } from './preparedDecision'
export { safeReasoningStatus } from './preparedDecision'
import { LlmClientError, type PromptPair } from './client'
import type { LlmProviderConfig } from './config'
import { tileName, type CanonicalAction, type DecisionRequest, type StateSnapshotV1 } from './schema'
import type { AnalysisLegalAction } from '../replay/analysis/types'
import type { LlmSpeechPriority } from './speechPolicy'
import { resolveDecisionSpeech, type DecisionSpeechFacts } from './decisionSpeech'
import { ConditionalReasoningCoordinator } from './conditionalReasoning'

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
  /** ε-容忍约束跳过的窗口数（血流 LLM 座；未启用 ε 时恒为 0）。 */
  gateSkips?: number
}

export function createLlmStats(): LlmControllerStats {
  return {
    requests: 0, successes: 0, fallbacks: 0, messages: 0, invalidActions: 0,
    reasoningRequests: 0, thinkingRequests: 0, enhancedReasoningRequests: 0, gateSkips: 0,
  }
}

/**
 * 一次真实模型请求的开始（分析记录接缝，见
 * docs/blood-flow/design/analysis-two-variants-work-agreement.md §5）。
 *
 * 只在**真的发出了请求**时触发：没有候选、候选只有一个（被短路成本地策略）时不触发 ——
 * 没有发生的请求不能记成一次尝试。不传钩子时这条路径一个分支都不进。
 */
export interface LlmDecisionRequestHookInput {
  /** 决策者座位（绝对索引，不是本机视角的旋转座位）。 */
  seat: number
  /** 本次请求的引擎侧标识（经典本地引擎为 `${kind}-${seat}-${序号}`，见 core/controllers/llmContext.ts）。 */
  requestId: string
  /**
   * 该请求所属的决策窗口。经典本地引擎没有独立的权威窗口号，因此这里就是引擎侧请求标识
   * （请求内容里逐字带来的 `requestId`，事后可由同一份对局状态复算）；分析侧用它把
   * attempt 关联到自己记录的窗口，不要在两侧各推一套编号。
   */
  windowId: string
  /**
   * 该座位此刻**模型可以选择**的动作。LLM 接缝能看到的动作词汇就是候选集，
   * 引擎合法集合的超集在玩法引擎侧（两边用 `id` 对齐，见 `candidates`）。
   */
  legalActions: AnalysisLegalAction[]
  /** 候选动作：`id` 是 `legalActions` 里的窗口内稳定 ID，`summary` 是提示词里的编号（A1/A2…）。 */
  candidates: Array<{ id: string; label?: string; summary?: string; action: unknown }>
  /** 真正发给这次请求的推荐（对应 `request.engineSuggestion`），不是事后补算。 */
  recommended?: { candidateId: string; note?: string }
  /** 提示词模板 id（按 id 去重只存一份正文，见 `decisionPromptTemplateId`）。 */
  promptTemplateId: string
  /**
   * 实际发给模型的变量（逐字）。`user` 就是 `messages.user`，**必须**与发给模型的那一份逐字相等。
   * `system` 是模板正文：接缝把它交给 `recorder.promptTemplate({ id, content })` 按 id **只存一次**，
   * 之后不必再逐次复制（§4）。变量里不得出现 API Key / Authorization / Cookie。
   */
  promptVariables: unknown
  provider: string
  model: string
  /** 墙钟（`Date.now()`）：只在两个进程间对齐"什么时候发的"，不用于耗时口径。 */
  sentAt: number
}

/** 一次真实模型请求的结束（成功、解析失败、超时、异常都要如实上报，§4、§5）。 */
export interface LlmDecisionAnswerHookInput {
  requestId: string
  /** 模型给出的牌桌原话（输出的 message 字段）；不是内部思考，也不是逐 token 流水（§4）。 */
  raw: string
  /** 解析到的候选 id；拿不到回答时为 null。 */
  choice: string | null
  /** `invalid` = 回答了但候选不存在/复核不合法；`timeout`/`error` = 请求本身失败。 */
  outcome: 'success' | 'invalid' | 'timeout' | 'error'
  /** 回退到本地策略时的原因（`outcome !== 'success'` 必须带；决策来源要据此记为 model-fallback）。 */
  fallback?: { reason: string }
  /** 供应商用量：本层拿不到就不填，绝不填 0 冒充（§3.3）。 */
  usage?: unknown
  /** 供应商返回的模型版本：本层拿不到就不填。 */
  responseModel?: string
  completedAt: number
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
  /** 一次真实请求开始：候选、推荐、模型与提示词引用。不传时零成本（§5）。 */
  onDecisionRequest?(input: LlmDecisionRequestHookInput): void
  /** 一次请求结束：原话回答、解析结果、失败与回退原因。不传时零成本（§5）。 */
  onDecisionAnswer?(input: LlmDecisionAnswerHookInput): void
}

/** 提示词模板版本：`buildPrompt` 的正文随代码变化，正文变了必须递增这个号（§5 按版本去重存一次）。 */
export const DECISION_PROMPT_TEMPLATE_VERSION = 1

/** 提示词模板 id：正文由玩法摘要 + 台词风格决定，因此 id 随二者变化。 */
export function decisionPromptTemplateId(ruleCode: string, style: string): string {
  return `decision-prompt/${DECISION_PROMPT_TEMPLATE_VERSION}/${ruleCode}/${style}`
}

/** 窗口内稳定 ID（与血流 `legalActionId` 同一口径：`${windowId}/${下标}`）。 */
function analysisLegalActionId(windowId: string, index: number): string {
  return `${windowId}/${index}`
}

/**
 * 把本层的规范动作折成分析用动作（方案 §3.3）。
 * 吃牌带上组合：只有 `optionIndex` 无法区分吃了哪一组，重放时会吃错面子。
 */
function analysisLegalActionOf(
  windowId: string,
  index: number,
  action: CanonicalAction,
  input: DecisionInput,
): AnalysisLegalAction {
  const normalized: AnalysisLegalAction = { id: analysisLegalActionId(windowId, index), kind: action.kind }
  switch (action.kind) {
    case 'discard':
      normalized.handIndex = action.handIndex
      normalized.tile = input.hand[action.handIndex] ? tileName(input.hand[action.handIndex]) : undefined
      break
    case 'added-kong':
      normalized.meldIndex = action.meldIndex
      normalized.tile = input.melds[action.meldIndex] ? tileName(input.melds[action.meldIndex].tile) : undefined
      break
    case 'concealed-kong':
      normalized.tile = tileName(action.tile)
      break
    case 'wind-kong':
      break
    case 'chi': {
      const meld = input.chiOptions?.[action.optionIndex]
      if (meld) normalized.meld = meld.tiles.map(tileName)
      break
    }
    case 'gang':
    case 'peng':
      if (input.tile) normalized.tile = tileName(input.tile)
      if (input.from !== undefined) normalized.from = input.from
      break
    default:
      break
  }
  return normalized
}

/** 失败的收口口径：超时与其它异常分开记，回退原因取错误消息（截断，避免把整段响应写进记录）。 */
function answerFailureOf(error: unknown): Pick<LlmDecisionAnswerHookInput, 'outcome' | 'fallback'> {
  const timedOut = error instanceof LlmClientError
    ? error.kind === 'timeout'
    : error instanceof Error && error.name === 'AbortError'
  const detail = error instanceof Error ? error.message : String(error)
  return {
    outcome: timedOut ? 'timeout' : 'error',
    fallback: { reason: `${timedOut ? 'timeout' : 'error'}:${detail.slice(0, 120)}` },
  }
}

/**
 * 分析上报器：把一次请求的开始/结束按 §5 的形状整理出来。
 * `hooks` 一个都没传时返回 null（调用方据此一个分支都不进）；整理过程自身绝不抛错 ——
 * 分析记录失败最多丢一条记录，绝不能影响在飞的模型请求与对局（§9.5）。
 */
function createDecisionHookReporter(
  hooks: LlmControllerHooks,
  config: LlmProviderConfig,
  input: DecisionInput,
  request: DecisionRequest,
  prompt: PromptPair,
) {
  const requestId = request.requestId
  // 没有引擎请求标识时（例如自建调用方不传）给一个由座位与状态版本推出的确定性 id：
  // 宁可标记成"非引擎请求"，也不要与别的窗口撞成同一个号。
  const windowId = requestId || `request-${request.ruleCode}-${input.playerIndex}-${request.stateVersion}`
  const candidates = request.candidates.map((candidate, index) => ({
    id: analysisLegalActionId(windowId, index),
    label: candidate.label,
    // 提示词里的编号（A1/A2…）：把落库的 promptVariables.user 与候选对起来时要用它
    summary: candidate.id,
    action: candidate.action,
  }))
  const legalActions = request.candidates.map((candidate, index) =>
    analysisLegalActionOf(windowId, index, candidate.action, input))
  const suggestionIndex = request.engineSuggestion
    ? request.candidates.findIndex((candidate) => candidate.id === request.engineSuggestion)
    : -1
  let started = false
  return {
    requested() {
      if (!hooks.onDecisionRequest) return
      started = true
      try {
        hooks.onDecisionRequest({
          seat: input.playerIndex,
          requestId,
          windowId,
          legalActions,
          candidates,
          ...(suggestionIndex >= 0
            ? { recommended: { candidateId: analysisLegalActionId(windowId, suggestionIndex), note: 'engine-suggestion' } }
            : {}),
          promptTemplateId: decisionPromptTemplateId(request.ruleCode, config.style),
          // 逐字保存实际发给模型的变量：`user` 与 messages.user 是同一份字符串，`system` 是模板正文
          promptVariables: {
            system: prompt.system,
            user: prompt.user,
            ruleCode: request.ruleCode,
            decision: request.decision,
            requestId,
            stateVersion: request.stateVersion,
            engineSuggestion: request.engineSuggestion ?? null,
            candidateIds: request.candidates.map((candidate) => candidate.id),
          },
          provider: config.providerType ?? 'unknown',
          model: config.model,
          sentAt: Date.now(),
        })
      } catch { /* 上报失败不影响请求（§9.5） */ }
    },
    answered(result: Omit<LlmDecisionAnswerHookInput, 'requestId' | 'completedAt'>) {
      if (!hooks.onDecisionAnswer || !started) return
      try {
        hooks.onDecisionAnswer({ requestId, ...result, completedAt: Date.now() })
      } catch { /* 上报失败不影响请求（§9.5） */ }
    },
  }
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
  const prompt = buildPrompt(config.style, built.request)
  // AI 分析记录接缝（§5）：只旁路上报这次请求的开始/结束，不参与决策；两个钩子都不传时为 null。
  // 这里不 try/catch 之外的任何改动 —— 上报器内部已经吞掉自己的异常（§9.5）。
  const report = hooks.onDecisionRequest || hooks.onDecisionAnswer
    ? createDecisionHookReporter(hooks, config, input, built.request, prompt)
    : null
  report?.requested()
  try {
    const output = await requestPreparedDecision({config,decision:built.request,messages:prompt,
      seat:input.playerIndex,stats,reasoning,onStatus:(active,text)=>hooks.onLlmStatus?.(input.playerIndex,active,text)})
    const candidate = built.request.candidates.find((item) => item.id === output.choice)
    if (!candidate) {
      stats.fallbacks += 1
      report?.answered({ raw: output.message ?? '', choice: output.choice ?? null, outcome: 'invalid',
        fallback: { reason: 'choice-not-in-candidates' } })
      await notifyFallback()
      return built.fallbackAction
    }
    // 自校验（§8）：对照当前 ctx 复核合法性；任何越界/不满足 → 回退（引擎执行层还会再复核一次）
    if (!isActionLegal(input, candidate.action)) {
      stats.invalidActions += 1
      stats.fallbacks += 1
      report?.answered({ raw: output.message ?? '', choice: output.choice ?? null, outcome: 'invalid',
        fallback: { reason: 'choice-illegal-after-recheck' } })
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
    report?.answered({ raw: output.message ?? '', choice: output.choice ?? null, outcome: 'success' })
    return candidate.action
  } catch (error) {
    stats.fallbacks += 1
    report?.answered({ raw: '', choice: null, ...answerFailureOf(error) })
    await notifyFallback()
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
