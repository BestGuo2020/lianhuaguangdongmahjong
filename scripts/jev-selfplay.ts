// Jev 血流无头自对弈：Node 直驱 BloodFlowEngine（与 scripts/blood-flow.sim.test.ts 同一驱动方式），
// 四座可配 jev-blind / jev-hint / ev / heuristic，进程内挂分析记录（内存 storage 驱动）与展示回放采集，
// 产出自包含分析包（buildAnalysisExport）供 scripts/analyze-jev-selfplay.mjs 与大模型复盘使用。
//
// 口径约定（与生产链路对齐，见 docs/blood-flow/design/replay-ai-analysis-recording.md）：
// - 决策记录三层：引擎合法动作（legalActions）→ 策略候选（candidates，含路线收窄 restricted）→ 实际选择（choice）。
// - Jev 请求走 attemptStarted/attemptFinished；失败回退记 fallback（strategy: 'ev'）且来源归为 model-fallback。
// - 单候选窗口自动执行，来源 rule-auto，**不虚构 attempt**。
// - 执行回执在窗口解决后统一判定（choiceTookEffect）；弃牌被胡转移出牌河时如实记 executed + 明细。
// - 复现数据（reproduction）按生产同一形状：初始牌墙 + 四家初始手牌 + 完整命令（含 legalActionId）。
// - 引擎时钟为虚拟时钟（每次提交 +1000ms）；recorder 的单调时钟是真实 performance.now()（Jev 延迟如实入账）。
//
// 显式 CLI（冒烟）：node node_modules/vitest/vitest.mjs run --dir scripts jev-selfplay.test.ts
// 批量落盘：node node_modules/vitest/vitest.mjs run --dir scripts jev-selfplay-run.test.ts
import { performance } from 'node:perf_hooks'
import { appendFileSync } from 'node:fs'
import type { MatchType } from '../src/game/core/contracts/types'
import type { LlmProviderConfig } from '../src/game/llm/config'
import { LlmClientError } from '../src/game/llm/client'
import { requestJevDecision } from '../src/game/llm/jevClient'
import {
  JEV_BLOOD_FLOW_CLAIM_INSTRUCTIONS, JEV_BLOOD_FLOW_TURN_INSTRUCTIONS,
  buildJevBloodFlowRequest, jevBloodFlowTemplateId, type JevBloodFlowMode,
} from '../src/game/llm/jevBloodFlowInput'
import { BLOOD_FLOW_PROMPT_RULES, buildBloodFlowDecisionInput } from '../src/game/llm/bloodFlowDecisionInput'
import { BloodFlowEngine } from '../src/game/variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { seededRandom } from '../src/game/variants/lotus/bloodFlow/simulation'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_LLM_AI } from '../src/game/variants/lotus/bloodFlow/config'
import { decideBloodFlowAction, decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import type { BloodFlowAction } from '../src/game/variants/lotus/bloodFlow/state'
import { SEATS } from '../src/game/variants/lotus/bloodFlow/state'
import type { Seat } from '../src/game/variants/lotus/bloodFlow/types'
import { createAnalysisRecorder, type AnalysisRecorder } from '../src/game/replay/analysis/recorder'
import { createAnalysisStorage } from '../src/game/replay/analysis/storage'
import { createAnalysisMemoryDriver } from '../src/game/replay/analysis/idb'
import { buildAnalysisExport, type AnalysisExportPayload } from '../src/game/replay/analysis/export'
import { fingerprintOf } from '../src/game/replay/analysis/codec'
import {
  choiceTookEffect, decisionStateOf, legalActionsOf, settlementsFromView, windowKindOf,
} from '../src/game/replay/analysis/bloodFlowAdapter'
import { UNKNOWN, known, type AnalysisCandidate, type AnalysisChoiceSource, type AnalysisLlmOutcome } from '../src/game/replay/analysis/types'
import { createReplayRecorder } from '../src/game/replay/recorder'
import {
  createBloodFlowRecordState, recordBloodFlowSettle, recordBloodFlowView,
  type BloodFlowRecordContext,
} from '../src/game/replay/bloodFlowRecorder'
import type { ReplayMatch, ReplayRound, ReplayStanding } from '../src/game/replay/types'

export type SelfplaySeatPolicy = 'jev-blind' | 'jev-hint' | 'ev' | 'heuristic'

export interface JevSelfplayJevOptions {
  /** /v1/systemone 端点配置（baseUrl 指服务根，如 http://127.0.0.1:8000）。 */
  config: LlmProviderConfig
  /** 后端标注（写入分析记录 provider 字段），如 'openjev-qwen2.5-1.5b' / 'mock'。 */
  backend?: string
}

/**
 * gold 数据采集（校正飞轮第一步）：每个决策点落一行 OpenJev calibrate/eval 格式样本
 * `{state, questions:{action}, gold:{action: engineSuggestion}}`。
 * 与 pilot 请求构造走**同一个** buildJevBloodFlowRequest（模板漂移即校准数据失效，必须同源）。
 */
export interface JevSelfplayCollectOptions {
  /** 输出 JSONL 路径（逐行追加；调用方负责文件不存在/轮转）。 */
  path: string
  /** 用哪个模式的 criteria 渲染采集（默认 hint——校正主要服务 hint 臂）。 */
  mode?: JevBloodFlowMode
  /** 样本上限；达到后不再追加（缺省不限）。 */
  maxSamples?: number
}

export interface JevSelfplayOptions {
  /** 场次种子：各局种子由它确定性派生（matchSeed + roundIndex*7919）。 */
  matchSeed: number
  /** 场数（局数）：默认 1；>1 时携分轮庄。 */
  rounds?: number
  seats: readonly [SelfplaySeatPolicy, SelfplaySeatPolicy, SelfplaySeatPolicy, SelfplaySeatPolicy]
  /** 有 jev-* 座位时必填。 */
  jev?: JevSelfplayJevOptions
  /** 构建标识（git commit）；缺省 'unknown'，正式批量运行必须传。 */
  engineBuild?: string
  matchType?: MatchType
  /** 关闭分析采集（只跑对局与展示回放）。默认开启。 */
  analysis?: boolean
  /** gold 数据采集（校正飞轮）；与 jev 座位可共存但通常配全 EV 座位使用（无需服务端点）。 */
  collect?: JevSelfplayCollectOptions
  signal?: AbortSignal
  onDecision?: (info: {
    roundIndex: number; seat: number; policy: SelfplaySeatPolicy
    windowId: string; source: AnalysisChoiceSource; elapsedMs: number
  }) => void
}

export interface JevSelfplayRoundResult {
  roundIndex: number
  seed: number
  dealer: Seat
  openingScores: number[]
  endingScores: number[]
  deltas: number[]
  winCounts: number[]
  reason: string
  submits: number
  jev: { requests: number; failures: number; fallbacks: number; totalMs: number }
  elapsedMs: number
}

export interface JevSelfplayMatchResult {
  matchId: string
  seats: readonly SelfplaySeatPolicy[]
  rounds: JevSelfplayRoundResult[]
  finalScores: number[]
  standings: ReplayStanding[]
  replayMatch: ReplayMatch | null
  replayRounds: ReplayRound[]
  /** 分析区读取结果（未开启分析时为 null）。 */
  analysis: { parts: number; configurations: number; status: string; complete: boolean } | null
  exportPayload: AnalysisExportPayload | null
  /** 本次调用追加的 gold 样本行数（未开启 collect 时为 0）。 */
  collectedSamples: number
  totalElapsedMs: number
}

const CLOCK_STEP_MS = 1000
const MAX_SUBMITS_PER_ROUND = 3000
const RULESET_ID = 'lotus-blood-flow' as const

function findLegalIndex(options: readonly BloodFlowAction[], action: BloodFlowAction): number {
  const key = JSON.stringify(action)
  const exact = options.findIndex((option) => JSON.stringify(option) === key)
  if (exact >= 0) return exact
  const field = (value: unknown, name: string) => (value as Record<string, unknown> | null)?.[name]
  return options.findIndex((option) => option.kind === action.kind
    && field(option, 'index') === field(action, 'index')
    && field(option, 'tile') === field(action, 'tile')
    && field(option, 'meldIndex') === field(action, 'meldIndex')
    && JSON.stringify(field(option, 'tiles') ?? null) === JSON.stringify(field(action, 'tiles') ?? null))
}

/** 窗口解决后的执行回执判定：choiceTookEffect 优先；弃牌被胡转移出牌河时如实记 executed。 */
function receiptStatusOf(input: {
  seat: Seat
  action: BloodFlowAction
  window: NonNullable<BloodFlowEngine['window']>
  before: ReturnType<typeof bloodFlowSeatView>
  after: ReturnType<typeof bloodFlowSeatView>
}): { status: 'executed' | 'overridden' | 'state-changed'; detail?: string } {
  const { seat, action, window, before, after } = input
  if (choiceTookEffect(before, after, seat, action)) return { status: 'executed' }
  // 点炮：弃牌真的发生了，只是被胡牌批次从牌河转移走（引擎 discards.pop）。
  const batches = after.public.batches
  if (action.kind === 'discard' && batches.some((batch) => batch.source.seat === seat && batch.source.kind === 'discard' && batch.winners.length)) {
    return { status: 'executed', detail: '弃牌已执行并被胡牌命中（牌转移出牌河）' }
  }
  const rivals = SEATS.filter((other) => other !== seat
    && window.decisions[other] && window.decisions[other]!.kind !== 'pass')
  if (rivals.length) {
    return { status: 'overridden', detail: `同窗口其他座位动作优先生效（座位 ${rivals.join('、')}）` }
  }
  return { status: 'state-changed' }
}

export async function runJevSelfplayMatch(options: JevSelfplayOptions): Promise<JevSelfplayMatchResult> {
  const roundsTotal = Math.max(1, options.rounds ?? 1)
  const matchType = options.matchType ?? 'east'
  const analysisEnabled = options.analysis !== false
  const jevSeats = SEATS.filter((seat) => options.seats[seat].startsWith('jev'))
  if (jevSeats.length && !options.jev) throw new Error('存在 jev-* 座位但未提供 jev.config')
  const jevConfig = options.jev?.config
  const jevProvider = `jev${options.jev?.backend ? `:${options.jev.backend}` : ''}`
  const engineBuild = options.engineBuild ?? 'unknown'
  const collect = options.collect
  let collectedSamples = 0
  const monotonic = () => performance.now()
  const matchStartedAt = monotonic()

  // 展示回放：内存 sink（不落 IDB），场次 id 与分析记录共享（§9.2 同一把钥匙）。
  const replayRecorder = createReplayRecorder({
    sink: { saveMatch: () => {}, saveRound: () => {} },
    meta: () => ({
      rulesetId: RULESET_ID,
      rulesetName: '莲花麻将血流（Jev 自对弈）',
      themeName: 'jade' as const,
      humanSeat: 0,
      gameMode: 'local' as const,
      analysisRecorded: analysisEnabled,
    }),
    now: () => Date.now(),
  })
  const matchId = replayRecorder.ensureMatchId()

  const storage = analysisEnabled
    ? createAnalysisStorage({ driver: createAnalysisMemoryDriver(), probeEstimateOnCreate: false })
    : null
  // 录制失败在异步 flush 里上报：当场抛会变成 unhandled rejection，收集起来场末统一处置。
  const analysisErrors: string[] = []
  const recorder: AnalysisRecorder | null = analysisEnabled
    ? createAnalysisRecorder({
      enabled: true, matchId, rulesetId: RULESET_ID,
      storage, now: () => Date.now(), monotonic,
      onError: (detail) => { analysisErrors.push(detail) },
    })
    : null
  if (recorder) {
    const modes = [...new Set(jevSeats.map((seat) => (options.seats[seat] === 'jev-blind' ? 'blind' : 'hint') as JevBloodFlowMode))]
    recorder.beginMatch({
      engineBuild,
      rulesVersion: String(BLOOD_FLOW_CONFIG.version),
      rulesFingerprint: fingerprintOf(BLOOD_FLOW_CONFIG),
      rules: structuredClone(BLOOD_FLOW_CONFIG) as unknown as Record<string, unknown>,
      aiStrategy: 'jev-selfplay-v1',
      aiFingerprint: fingerprintOf({ seats: options.seats, aiConfig: BLOOD_FLOW_LLM_AI, matchSeed: options.matchSeed }),
      aiConfig: structuredClone(BLOOD_FLOW_LLM_AI) as unknown as Record<string, unknown>,
      seatControl: options.seats.map((policy) => (policy.startsWith('jev') ? 'llm' : 'local-ai')),
      models: jevSeats.map((seat) => ({
        seat, provider: jevProvider, requestModel: jevConfig!.model,
        responseModel: UNKNOWN,
        sampling: { mode: options.seats[seat] === 'jev-blind' ? 'blind' : 'hint', selection: 'argmax' },
      })),
      promptTemplates: modes.map((mode) => ({
        id: jevBloodFlowTemplateId(mode),
        fingerprint: fingerprintOf({
          mode, rules: BLOOD_FLOW_PROMPT_RULES,
          turn: JEV_BLOOD_FLOW_TURN_INSTRUCTIONS, claim: JEV_BLOOD_FLOW_CLAIM_INSTRUCTIONS,
        }),
        text: JSON.stringify({
          mode, rules: BLOOD_FLOW_PROMPT_RULES,
          turnInstructions: JEV_BLOOD_FLOW_TURN_INSTRUCTIONS,
          claimInstructions: JEV_BLOOD_FLOW_CLAIM_INSTRUCTIONS,
          criteria: mode === 'blind' ? '候选仅动作名（label）' : '候选附紧凑特征短语（label·tokens：向/进/听/安/险/得/链/门/改/抢/发/EV/杠净/收，不含推荐标记）',
        }),
      })),
    })
  }

  const roundResults: JevSelfplayRoundResult[] = []
  let scores: [number, number, number, number] = SEATS.map(() => BLOOD_FLOW_CONFIG.initialScore) as [number, number, number, number]

  for (let roundIndex = 1; roundIndex <= roundsTotal; roundIndex += 1) {
    if (options.signal?.aborted) throw new Error('Jev 自对弈已取消')
    const seed = (options.matchSeed + roundIndex * 7919) >>> 0
    const dealer = ((roundIndex - 1) % 4) as Seat
    const roundStartedAt = monotonic()
    const authorityEpoch = `jev-selfplay/${matchId}`
    const roundId = `${matchId}/r${roundIndex}`
    let clock = 0
    const engine = new BloodFlowEngine({
      authorityEpoch, roundId, random: seededRandom(seed), scores, dealer,
      now: () => clock, winBeatMs: 0, recordCommands: Boolean(recorder),
      // 无头对局从不超时（不调用 expire）；虚拟时钟每次提交 +1s，放宽截止以免长局里
      // windowIsOpen() 变 false 导致视角 ownActions 为空、候选层塌陷。
      decisionMs: 600_000_000,
    })
    const openingScores = [...scores]
    const recordContext: BloodFlowRecordContext = {
      matchType, round: roundIndex, dealer, honba: 0,
      ...(engine.initialDice.first ? { firstDice: [...engine.initialDice.first] } : {}),
      ...(engine.initialDice.second ? { secondDice: [...engine.initialDice.second] } : {}),
      diceThrowerIndex: dealer,
      wildcardTiles: [],
    }
    const recordState = createBloodFlowRecordState()
    const spectatorOf = () => bloodFlowSeatView(engine, 0 as Seat, { revealAll: true, includeDiscards: true })
    const recordSpectator = () => recordBloodFlowView(replayRecorder.hooks, spectatorOf(), recordContext, recordState)
    recordSpectator() // 开局锚点（roundStart）

    const settlementSeen = new Set<string>()
    const legalIdByWindowSeat = new Map<string, string>()
    const roundJev = { requests: 0, failures: 0, fallbacks: 0, totalMs: 0 }
    let submits = 0

    /** 单座位决策（含全部分析记录）；返回要提交的动作与其合法动作 ID。 */
    async function decideSeat(seat: Seat, window: NonNullable<BloodFlowEngine['window']>) {
      const policy = options.seats[seat]
      const view = bloodFlowSeatView(engine, seat)
      const engineOptions = window.options[seat]
      const legalActions = legalActionsOf(window.id, engineOptions)
      const windowKind = windowKindOf(engineOptions)
      const openedAt = monotonic()
      const state = decisionStateOf(view, seat)
      const openWindowRecord = () => recorder?.windowOpened({
        windowId: window.id, seat, windowKind, roundIndex, authorityEpoch,
        stateVersion: window.version, sourceEventId: window.source.id,
        state: { ...state, fingerprint: fingerprintOf(state) },
        openedAt,
      })

      // 单候选：规则自动执行，不发请求、不造 attempt。
      if (engineOptions.length === 1) {
        openWindowRecord()
        recorder?.candidates({
          windowId: window.id, seat, legalActions,
          candidates: [{ legalActionId: legalActions[0].id, action: legalActions[0] }],
        })
        return { action: engineOptions[0], legalActionId: legalActions[0].id, source: 'rule-auto' as AnalysisChoiceSource }
      }

      const requestId = `${matchId}/${roundIndex}/${window.id}/${seat}`
      const input = buildBloodFlowDecisionInput(view, requestId, { roundIndex, dealerIndex: dealer }, BLOOD_FLOW_LLM_AI)
      openWindowRecord()
      const candidateIndex = new Map<string, number>()
      const analysisCandidates: AnalysisCandidate[] = []
      for (const candidate of input.candidates) {
        const index = findLegalIndex(engineOptions, candidate.action)
        if (index < 0) continue
        candidateIndex.set(candidate.id, index)
        analysisCandidates.push({ legalActionId: legalActions[index].id, action: legalActions[index] })
      }
      if (!analysisCandidates.length) {
        // 策略候选与引擎合法动作完全对不上（不应发生）：留痕并走本地 EV 兜底。
        recorder?.noteGap({ scope: 'candidate-mapping', from: roundIndex, reason: `窗口 ${window.id} 座位 ${seat} 的策略候选无法映射到合法动作集` })
        const fallback = decideBloodFlowActionEv(view, BLOOD_FLOW_LLM_AI) ?? engineOptions[0]
        const index = Math.max(0, findLegalIndex(engineOptions, fallback))
        recorder?.candidates({ windowId: window.id, seat, legalActions, candidates: [{ legalActionId: legalActions[index].id, action: legalActions[index] }] })
        return { action: engineOptions[index], legalActionId: legalActions[index].id, source: 'local-strategy' as AnalysisChoiceSource }
      }
      const restricted = input.collapsedActions
        .map((collapsed) => {
          const index = findLegalIndex(engineOptions, collapsed.action)
          return index >= 0 ? { legalActionId: legalActions[index].id, reason: collapsed.reason } : null
        })
        .filter((entry): entry is { legalActionId: string; reason: string } => entry !== null)
      const suggestionId = input.request.engineSuggestion
      const recommendedIndex = suggestionId !== undefined ? candidateIndex.get(suggestionId) : undefined
      recorder?.candidates({
        windowId: window.id, seat, legalActions, candidates: analysisCandidates,
        ...(restricted.length ? { restricted } : {}),
        recommended: recommendedIndex !== undefined
          ? known({ legalActionId: legalActions[recommendedIndex].id, note: '本地 EV 引擎推荐（engineSuggestion）' })
          : UNKNOWN,
      })

      // gold 采集（校正飞轮）：与 pilot 请求同源构造，保证校准数据与实际请求分布一致。
      // 只收「推荐存在且已映射进合法动作集」的样本；单候选窗口在上面已提前返回。
      if (collect && recommendedIndex !== undefined && suggestionId !== undefined
        && collectedSamples < (collect.maxSamples ?? Number.POSITIVE_INFINITY)) {
        const sample = buildJevBloodFlowRequest({ decision: input, mode: collect.mode ?? 'hint', requestId })
        appendFileSync(collect.path, `${JSON.stringify({
          state: sample.state,
          questions: {
            action: {
              type: 'choice',
              instructions: sample.instructions,
              criteria: Object.fromEntries(sample.candidates.map((candidate) => [candidate.id, candidate.description ?? null])),
            },
          },
          gold: { action: suggestionId },
        })}\n`, 'utf8')
        collectedSamples += 1
      }

      if (policy === 'jev-blind' || policy === 'jev-hint') {
        const mode: JevBloodFlowMode = policy === 'jev-blind' ? 'blind' : 'hint'
        const jevRequest = buildJevBloodFlowRequest({ decision: input, mode, requestId })
        const attemptId = recorder?.attemptStarted({
          decisionWindowId: window.id, seat, requestId, attempt: 1,
          provider: jevProvider, requestModel: jevConfig!.model,
          sampling: { mode, selection: 'argmax' },
          promptTemplateId: jevRequest.templateId,
          promptVariables: jevRequest.promptVariables,
          sentAt: monotonic(),
        }) ?? ''
        const evFallback = () => {
          const fallback = decideBloodFlowActionEv(view, BLOOD_FLOW_LLM_AI) ?? engineOptions[0]
          const index = Math.max(0, findLegalIndex(engineOptions, fallback))
          return { action: engineOptions[index], legalActionId: legalActions[index].id }
        }
        const requestStartedAt = monotonic()
        let result: Awaited<ReturnType<typeof requestJevDecision>>
        try {
          result = await requestJevDecision({
            config: jevConfig!,
            state: jevRequest.state,
            instructions: jevRequest.instructions,
            candidates: jevRequest.candidates,
            ...(options.signal ? { signal: options.signal } : {}),
          })
        } catch (error) {
          roundJev.requests += 1
          roundJev.failures += 1
          roundJev.fallbacks += 1
          roundJev.totalMs += monotonic() - requestStartedAt
          const kind = error instanceof LlmClientError ? error.kind : 'network'
          const outcome: AnalysisLlmOutcome = kind === 'timeout' ? 'timeout' : kind === 'parse' ? 'parse-failed' : 'network-error'
          const fallback = evFallback()
          recorder?.attemptFinished(attemptId, {
            outcome,
            responseModel: UNKNOWN,
            fallback: {
              reason: (error instanceof Error ? error.message : String(error)).slice(0, 200),
              strategy: 'ev',
              legalActionId: fallback.legalActionId,
            },
            completedAt: monotonic(),
          })
          if (options.signal?.aborted) throw error
          return { action: fallback.action, legalActionId: fallback.legalActionId, source: 'model-fallback' as AnalysisChoiceSource }
        }
        roundJev.requests += 1
        roundJev.totalMs += monotonic() - requestStartedAt
        const index = candidateIndex.get(result.choice)
        if (index === undefined) {
          // 客户端已做过白名单校验；走到这里说明「候选映射不到引擎合法动作集」，与解析失败分开归类。
          roundJev.failures += 1
          roundJev.fallbacks += 1
          const fallback = evFallback()
          recorder?.attemptFinished(attemptId, {
            outcome: 'candidate-missing',
            responseModel: UNKNOWN,
            answer: known({ text: '', candidateId: result.choice }),
            fallback: { reason: `回答候选 ${result.choice} 无法映射到合法动作`, strategy: 'ev', legalActionId: fallback.legalActionId },
            completedAt: monotonic(),
          })
          return { action: fallback.action, legalActionId: fallback.legalActionId, source: 'model-fallback' as AnalysisChoiceSource }
        }
        recorder?.attemptFinished(attemptId, {
          outcome: 'success',
          responseModel: UNKNOWN,
          answer: known({
            text: '', candidateId: result.choice,
            // 概率分布是 Jev 回答的实体（不是内部思考）：紧凑序列化供校准分析。
            note: JSON.stringify({ probabilities: result.probabilities, confidence: result.confidence, extras: result.extras }),
          }),
          usage: { candidates: jevRequest.candidates.length },
          completedAt: monotonic(),
        })
        return { action: engineOptions[index], legalActionId: legalActions[index].id, source: 'model' as AnalysisChoiceSource }
      }

      // 本地策略座位（ev = EV 策略；heuristic = 旧启发式）。
      const localAction = (policy === 'ev'
        ? decideBloodFlowActionEv(view, BLOOD_FLOW_LLM_AI)
        : decideBloodFlowAction(view)) ?? engineOptions[0]
      const index = findLegalIndex(engineOptions, localAction)
      if (index < 0) {
        recorder?.noteGap({ scope: 'policy-action', from: roundIndex, reason: `窗口 ${window.id} 座位 ${seat} 的策略动作不在合法动作集，回退首个合法动作` })
      }
      const chosen = index >= 0 ? index : 0
      return { action: engineOptions[chosen], legalActionId: legalActions[chosen].id, source: 'local-strategy' as AnalysisChoiceSource }
    }

    while (!engine.result) {
      const window = engine.window
      if (!window) throw new Error(`seed ${seed} 第 ${roundIndex} 局停滞：无窗口且无结果（提交 ${submits} 次）`)
      // 窗口内所有等待座位依次决策提交；解决后统一记执行回执。
      const pendingReceipts: Array<{
        seat: Seat; action: BloodFlowAction; legalActionId: string
        before: ReturnType<typeof bloodFlowSeatView>
      }> = []
      const windowId = window.id
      for (const seat of SEATS) {
        if (!window.options[seat].length || window.decisions[seat]) continue
        if (options.signal?.aborted) throw new Error('Jev 自对弈已取消')
        const decideStartedAt = monotonic()
        const decided = await decideSeat(seat, window)
        const before = bloodFlowSeatView(engine, seat)
        const accepted = engine.submit(engine.command(seat, decided.action))
        if (!accepted) throw new Error(`seed ${seed} 第 ${roundIndex} 局：引擎拒绝合法动作（窗口 ${windowId} 座位 ${seat}）`)
        clock += CLOCK_STEP_MS
        submits += 1
        recorder?.chosen({ windowId, seat, legalActionId: decided.legalActionId, source: decided.source, at: monotonic() })
        legalIdByWindowSeat.set(`${windowId}#${seat}`, decided.legalActionId)
        pendingReceipts.push({ seat, action: decided.action, legalActionId: decided.legalActionId, before })
        options.onDecision?.({
          roundIndex, seat, policy: options.seats[seat], windowId,
          source: decided.source, elapsedMs: monotonic() - decideStartedAt,
        })
        recordSpectator()
        if (submits > MAX_SUBMITS_PER_ROUND) throw new Error(`seed ${seed} 第 ${roundIndex} 局提交超上限（${MAX_SUBMITS_PER_ROUND}）`)
      }
      // 窗口已解决（换窗或终局）：补执行回执。
      if (engine.window?.id !== windowId || engine.result) {
        for (const receipt of pendingReceipts) {
          if (!recorder) break
          const after = bloodFlowSeatView(engine, receipt.seat)
          const { status, detail } = receiptStatusOf({ seat: receipt.seat, action: receipt.action, window, before: receipt.before, after })
          recorder.receipt({
            windowId, seat: receipt.seat, status,
            ...(status === 'executed' ? { executedLegalActionId: receipt.legalActionId } : {}),
            ...(detail ? { detail } : {}),
          })
        }
      }
      if (!engine.result && !engine.window) throw new Error(`seed ${seed} 第 ${roundIndex} 局停滞：窗口耗尽（提交 ${submits} 次）`)
    }

    // 局末：展示回放收尾（幂等）+ 结算流水 + 复现数据。
    const finalSpectator = spectatorOf()
    recordBloodFlowSettle(replayRecorder.hooks, finalSpectator, recordContext, recordState)
    if (recorder) {
      for (const settlement of settlementsFromView(finalSpectator, roundIndex, settlementSeen)) {
        recorder.settlement(settlement)
      }
      const opening = engine.initialOpening
      recorder.reproduction({
        roundIndex,
        available: true,
        origin: 'local',
        initialWall: [...opening.wall],
        initialHands: opening.players.map((player) => [...player.hand]),
        dealerDrawnIndex: opening.dealerDrawnIndex,
        flipTiles: [...opening.flipTiles],
        jokers: [...opening.jokers],
        flipSeat: opening.flipSeat,
        wallBreakIndex: opening.wallBreakIndex,
        dealer,
        openingScores: [...openingScores],
        flipTile: opening.flipTiles[0] ?? null,
        flipStack: opening.flipStack,
        commands: engine.recordedCommands.map((entry) => ({
          ...entry,
          ...(entry.legalActionId ? {} : {
            legalActionId: legalIdByWindowSeat.get(`${entry.windowId}#${entry.seat}`),
          }),
        })),
        randomSources: [{ scope: 'wall+dice', algorithm: 'xorshift32 (seededRandom)', seed: String(seed) }],
      })
    }

    const result = engine.result!
    const endingScores = SEATS.map((seat) => result.endingScores[seat])
    roundResults.push({
      roundIndex, seed, dealer,
      openingScores: [...openingScores],
      endingScores,
      deltas: SEATS.map((seat) => endingScores[seat] - openingScores[seat]),
      winCounts: SEATS.map((seat) => result.winCounts[seat]),
      reason: result.reason,
      submits,
      jev: { ...roundJev },
      elapsedMs: monotonic() - roundStartedAt,
    })
    scores = endingScores as [number, number, number, number]
  }

  // 场末收尾：展示回放 + 分析区刷盘 + 自包含分析包。
  const finalScores = [...scores]
  const standings: ReplayStanding[] = SEATS
    .map((seat) => ({ seat, name: `座位${seat + 1}（${options.seats[seat]}）`, score: finalScores[seat], rank: 0 }))
    .sort((a, b) => b.score - a.score)
    .map((standing, index) => ({ ...standing, rank: index + 1 }))
  const replayMatch = replayRecorder.finish('finished', standings)
  const snapshot = replayRecorder.snapshot()

  let analysis: JevSelfplayMatchResult['analysis'] = null
  let exportPayload: AnalysisExportPayload | null = null
  if (recorder && storage && replayMatch) {
    const finish = await recorder.finish()
    if (analysisErrors.length) {
      throw new Error(`分析录制落库失败（${analysisErrors.length} 次）：${analysisErrors[0]}`)
    }
    const read = await storage.read(matchId)
    const configurations = await storage.readConfigs(matchId)
    analysis = {
      parts: read.parts.length,
      configurations: configurations.length,
      status: finish.status,
      complete: read.complete,
    }
    exportPayload = buildAnalysisExport({
      match: replayMatch,
      rounds: snapshot.rounds,
      parts: read.parts,
      configurations,
      status: read.meta?.status ?? 'missing',
      gaps: read.meta?.gaps ?? [],
    })
  }

  return {
    matchId,
    seats: options.seats,
    rounds: roundResults,
    finalScores,
    standings,
    replayMatch,
    replayRounds: snapshot.rounds,
    analysis,
    exportPayload,
    collectedSamples,
    totalElapsedMs: monotonic() - matchStartedAt,
  }
}
