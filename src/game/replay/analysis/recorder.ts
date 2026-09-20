// 分析记录 P0：录制核心（方案 §3.2／§3.3／§3.4／§3.5，队列与失败处理见 §9.5）。
//
// 这个模块是"旁路观测者"：只接收游戏层已经产生的信息，不调用模型、不做反事实搜索、
// 不修改传进来的任何对象，也**永不抛错**——录制失败最多让分析暂停并留痕，绝不能影响对局（§9.5、§10）。
//
// 三层动作模型（§3.3）在这里落成：legalActions（引擎允许）→ candidates（策略实际能选，含被限制的）
// → choice（实际选了什么）。选择来源（模型／本地／人类／回退）与执行回执分开存：模型回答 ≠ 执行成功（§3.4）。
import { utf8Bytes, type AnalysisBlockPart } from './codec'
import type { AnalysisStorage } from './storage'
import type {
  AnalysisAreaStatus, AnalysisCandidate, AnalysisChoiceSource, AnalysisConfigRecord, AnalysisDecision,
  AnalysisDecisionState, AnalysisEstimates, AnalysisExecutionStatus, AnalysisLegalAction, AnalysisLlmAttempt,
  AnalysisLlmOutcome, AnalysisMaybe, AnalysisReproduction, AnalysisSeatControl, AnalysisSettlement,
  AnalysisWindowKind,
} from './types'
import { UNKNOWN } from './types'

/** 队列上限：超过即刷盘；写失败则暂停分析并留痕，不无限堆积内存（§9.5）。 */
export const ANALYSIS_QUEUE_LIMIT_BYTES = 256 * 1024

/** 视为"胡"的动作类型（不同玩法的命名不同，这里放宽匹配，避免把拒胡漏判成普通动作）。 */
const WIN_KINDS = new Set(['win', 'hu', 'zimo', 'self-draw', 'discard-win', 'robbed-kong-win', 'kong-bloom'])

export interface AnalysisMatchInput {
  engineBuild: string
  rulesVersion: string
  rulesFingerprint: string
  rules: Record<string, unknown>
  aiStrategy: string
  aiFingerprint: string
  aiConfig: Record<string, unknown>
  seatControl: AnalysisSeatControl[]
  models?: AnalysisConfigRecord['models']
  promptTemplates?: AnalysisConfigRecord['promptTemplates']
}

export interface AnalysisWindowInput {
  windowId: string
  seat: number
  windowKind: AnalysisWindowKind
  roundIndex: number
  authorityEpoch: string
  stateVersion: number
  sourceEventId?: string
  /** 决策前态：展示回放恢复不出来的部分（§3.2／§9.3）。 */
  state: {
    /** 状态指纹（去重与校验用）；同一 id 不会重复落库。 */
    id: string
    fingerprint?: string
    replay?: { roundIndex: number; stepIndex: number }
    hand?: string[]
    drawnTileIndex?: number
    melds?: number
    winScores?: AnalysisMaybe<Record<string, number>>
    locks?: Record<string, unknown>
    responderCheckpoint?: { seat: number; hand: string[]; drawnTileIndex: number }
    /** 该座位此刻的合法动作（§3.2：前态必须包含"当前合法动作"）。 */
    legalActions?: AnalysisLegalAction[]
  }
  /** 窗口开放时刻：**本进程单调时钟**（§3.5）。 */
  openedAt?: number
  deadlineAt?: number
}

export interface AnalysisCandidatesInput {
  windowId: string
  seat: number
  legalActions: AnalysisLegalAction[]
  candidates: AnalysisCandidate[]
  restricted?: Array<{ legalActionId: string; reason: string }>
  estimates?: AnalysisEstimates
  recommended?: AnalysisMaybe<{ legalActionId: string; note?: string }>
}

export interface AnalysisChoiceInput {
  windowId: string
  seat: number
  legalActionId: string | null
  source: AnalysisChoiceSource
  commandId?: string
  /** 本进程单调时钟。 */
  at?: number
}

export interface AnalysisReceiptInput {
  windowId: string
  seat: number
  status: AnalysisExecutionStatus
  eventId?: string
  detail?: string
  /** 引擎最终实际执行的动作（可能不是模型选的那个）。 */
  executedLegalActionId?: string
}

export interface AnalysisAttemptStartInput {
  decisionWindowId: string
  seat: number
  requestId: string
  attempt: number
  provider: string
  requestModel: string
  sampling: Record<string, unknown>
  promptTemplateId?: string
  promptVariables?: Record<string, unknown>
  sentAt?: number
}

export interface AnalysisAttemptFinishInput {
  outcome: AnalysisLlmOutcome
  responseModel?: AnalysisMaybe<string>
  answer?: AnalysisMaybe<{ text: string; candidateId?: string; note?: string }>
  fallback?: { reason: string; strategy: string; legalActionId?: string }
  usage?: Record<string, number>
  firstByteAt?: number
  completedAt?: number
}

export interface AnalysisRecorder {
  readonly enabled: boolean
  paused(): boolean
  beginMatch(input: AnalysisMatchInput): string
  windowOpened(input: AnalysisWindowInput): void
  candidates(input: AnalysisCandidatesInput): void
  chosen(input: AnalysisChoiceInput): void
  /** 运行时确定的来源（本地 AI／模型／回退）：chosen() 不得用 'unknown' 覆盖它（§3.4）。 */
  source(input: { windowId: string; seat: number; source: AnalysisChoiceSource }): void
  receipt(input: AnalysisReceiptInput): void
  attemptStarted(input: AnalysisAttemptStartInput): string
  attemptFinished(attemptId: string, input: AnalysisAttemptFinishInput): void
  settlement(input: Omit<AnalysisSettlement, 'id'> & { id?: string }): void
  reproduction(input: AnalysisReproduction): void
  noteGap(gap: { scope: string; from?: number; to?: number; reason: string }): void
  /** 把队列刷进分析区；失败只暂停分析（§9.5）。 */
  flush(reason?: string): Promise<void>
  /** 收尾：返回分析区状态（与 §9.2 的四态对齐：disabled／complete／partial／missing）。 */
  finish(): Promise<{ status: AnalysisAreaStatus; bytes: number }>
  diagnostics(): { decisions: number; attempts: number; pendingParts: number; pendingBytes: number; paused: boolean }
}

export interface AnalysisRecorderOptions {
  enabled: boolean
  matchId: string
  rulesetId: string
  storage?: AnalysisStorage | null
  /** 墙钟：只用于落库时间戳，不用于耗时（§3.5）。 */
  now?: () => number
  /** 单调时钟：所有耗时都用它（§3.5）。 */
  monotonic?: () => number
  queueLimitBytes?: number
  onError?: (detail: string) => void
}

const key = (windowId: string, seat: number) => `${windowId}#${seat}`

/**
 * 创建分析录制器。
 * `enabled: false` 时所有方法零成本空转（不构造快照、不生成估值、不请求模型，§9.2、§10.7）。
 */
export function createAnalysisRecorder(options: AnalysisRecorderOptions): AnalysisRecorder {
  const enabled = options.enabled
  const now = options.now ?? (() => Date.now())
  const monotonic = options.monotonic ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
  const queueLimit = Math.max(1, options.queueLimitBytes ?? ANALYSIS_QUEUE_LIMIT_BYTES)

  let configId = ''
  let paused = false
  let sequence = 0
  let decisionCount = 0
  let attemptCount = 0
  /** 队列：只在启用且未暂停时累积；暂停后直接丢弃新记录但保留缺失痕迹（§9.5）。 */
  let pending: AnalysisBlockPart[] = []
  let pendingBytes = 0
  const stateIds = new Set<string>()
  /** 运行时（决策运行时）确定的来源：优先级高于调用方在 chosen() 里报的 'unknown'。 */
  const runtimeSources = new Map<string, AnalysisChoiceSource>()
  const decisions = new Map<string, AnalysisDecision>()
  const attempts = new Map<string, AnalysisLlmAttempt>()
  const gaps: Array<{ scope: string; from?: number; to?: number; reason: string }> = []

  function report(detail: string) {
    try { options.onError?.(detail) } catch { /* 失败通知自身也必须安全（§9.5） */ }
  }

  function push(tag: string, value: unknown) {
    if (!enabled || paused) return
    const part: AnalysisBlockPart = { tag, value }
    pending.push(part)
    pendingBytes += utf8Bytes(JSON.stringify(part))
    if (pendingBytes >= queueLimit) void flush('queue-limit')
  }

  /**
   * 写入串行化：并发 flush 会各自读到同一个 nextSequence，后写的块被判 sequence-occupied。
   * 真实浏览器 e2e 实测到过 `paused sequence-occupied(sequence=13)`（队列自动刷盘与场末收尾撞在一起）。
   * 所有写入按调用顺序排队，前一次落库完成后才开始下一次。
   */
  let flushChain: Promise<void> = Promise.resolve()
  async function flush(reason = 'manual'): Promise<void> {
    const previous = flushChain
    let release: () => void = () => {}
    flushChain = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      await flushOnce(reason)
    } finally {
      release()
    }
  }

  async function flushOnce(reason = 'manual'): Promise<void> {
    if (!enabled || paused || !pending.length) return
    const storage = options.storage
    if (!storage || !storage.available()) {
      // 没有分析区可用：暂停并留痕，不静默丢弃也不无限堆积（§9.5）
      paused = true
      report(`分析区不可用（${reason}）`)
      pending = []
      pendingBytes = 0
      return
    }
    const parts = pending
    pending = []
    pendingBytes = 0
    const result = await storage.write(options.matchId, { rulesetId: options.rulesetId }, parts)
    if (!result.ok) {
      paused = true
      report(`分析落库失败（${reason}）：${result.reason}${result.detail ? ` ${result.detail}` : ''}`)
      await storage.noteGap(options.matchId, { scope: 'analysis', reason: `write-${result.reason}` })
    }
  }

  /** 取（或新建）决策；同一个窗口+座位只有一条决策（§3.2：不能假定一一对应，但也不能重复记）。 */
  function decisionFor(windowId: string, seat: number): AnalysisDecision | null {
    if (!enabled || paused) return null
    const id = key(windowId, seat)
    const existing = decisions.get(id)
    if (existing) return existing
    const created: AnalysisDecision = {
      id: `decision/${options.matchId}/${windowId}/${seat}`,
      matchId: options.matchId,
      roundIndex: 0,
      authorityEpoch: '',
      windowId,
      stateVersion: 0,
      seat,
      windowKind: 'other',
      stateId: '',
      choice: UNKNOWN,
      source: 'unknown',
      execution: { status: 'pending' },
      timing: {},
      configId,
    }
    decisions.set(id, created)
    return created
  }

  return {
    enabled,
    paused: () => paused,

    beginMatch(input) {
      if (!enabled || paused) return ''
      configId = `config/${options.matchId}/${++sequence}`
      const record: AnalysisConfigRecord = {
        id: configId,
        formatVersion: 1,
        effectiveFromRound: 1,
        engineBuild: input.engineBuild,
        rulesVersion: input.rulesVersion,
        rulesFingerprint: input.rulesFingerprint,
        rules: { ...input.rules },
        aiStrategy: input.aiStrategy,
        aiFingerprint: input.aiFingerprint,
        aiConfig: { ...input.aiConfig },
        seatControl: [...input.seatControl],
        ...(input.models ? { models: structuredClone(input.models) } : {}),
        ...(input.promptTemplates ? { promptTemplates: structuredClone(input.promptTemplates) } : {}),
      }
      // §9.4：登记配置引用。此前只有单测调用过 retainConfig，生产路径从未接线，
      // 于是「A、B 两场共享同一模板 → 只存一份 → 零引用才回收」这套机制实际是死代码。
      void Promise.resolve(options.storage?.retainConfig(options.matchId, { id: configId, value: record }))
        .catch(() => { /* 引用登记失败不影响录制本身（§9.5 独立失败域） */ })
      push('config', record)
      return configId
    },

    windowOpened(input) {
      const decision = decisionFor(input.windowId, input.seat)
      if (!decision) return
      decision.roundIndex = input.roundIndex
      decision.authorityEpoch = input.authorityEpoch
      decision.stateVersion = input.stateVersion
      decision.windowKind = input.windowKind
      decision.stateId = input.state.id
      if (input.sourceEventId !== undefined) decision.sourceEventId = input.sourceEventId
      decision.timing.windowOpenedAt = input.openedAt ?? monotonic()
      if (input.deadlineAt !== undefined) decision.timing.deadlineAt = input.deadlineAt
      // 决策前态按 id 去重：同一状态不重复落库（§9.3 禁止重复快照）
      if (stateIds.has(input.state.id)) return
      stateIds.add(input.state.id)
      const state: AnalysisDecisionState = {
        id: input.state.id,
        fingerprint: input.state.fingerprint ?? '',
        legalActions: (input.state.legalActions ?? []).map((action) => ({
          ...action, ...(action.meld ? { meld: [...action.meld] } : {}),
        })),
        ...(input.state.replay ? { replay: { ...input.state.replay } } : {}),
        ...(input.state.hand ? { hand: [...input.state.hand] } : {}),
        ...(input.state.drawnTileIndex !== undefined ? { drawnTileIndex: input.state.drawnTileIndex } : {}),
        ...(input.state.melds !== undefined ? { melds: input.state.melds } : {}),
        ...(input.state.winScores ? { winScores: input.state.winScores } : {}),
        ...(input.state.locks ? { locks: structuredClone(input.state.locks) } : {}),
        ...(input.state.responderCheckpoint
          ? { responderCheckpoint: { ...input.state.responderCheckpoint, hand: [...input.state.responderCheckpoint.hand] } }
          : {}),
      }
      // 合法动作随后由 candidates() 补齐到同一份状态上（stateId 相同即同一份）
      push('decisionState', state)

      // 响应窗口检查点（§9.3 的格式缺口）：
      // 展示回放的步骤流只含**行动者**视角，响应座位（吃碰杠胡/过）当时的手牌无法从中还原，
      // 因此"按当时所见"必须依赖这里显式记下的检查点。
      // 只有真的看到该座位手牌时才写检查点；看不到就记缺失原因，**绝不**凭空补一份。
      if (input.windowKind === 'claim') {
        const hand = input.state.hand ?? []
        if (hand.length) {
          // 检查点作为独立记录落库（用 decisionId 与决策关联），而不是塞进决策对象：
          // 它是"当时该座位看到了什么"的独立事实，与决策本身分开存更好审阅。
          push('responderCheckpoint', {
            decisionId: `decision/${options.matchId}/${input.windowId}/${input.seat}`,
            windowId: input.windowId,
            seat: input.seat,
            roundIndex: input.roundIndex,
            hand: [...hand],
            drawnTileIndex: input.state.drawnTileIndex ?? -1,
          })
        } else {
          // 看不到该座位手牌（视角不含别家手牌）⇒ 留痕，不凭空补
          gaps.push({ scope: 'responder-checkpoint', from: input.roundIndex, reason: '响应窗口缺少该座位手牌（视角不含别家手牌）' })
        }
      }
    },

    candidates(input) {
      const decision = decisionFor(input.windowId, input.seat)
      if (!decision) return
      decision.candidates = input.candidates.map((candidate) => ({
        legalActionId: candidate.legalActionId,
        action: { ...candidate.action },
        ...(candidate.reason ? { reason: candidate.reason } : {}),
      }))
      if (input.restricted?.length) decision.restricted = input.restricted.map((item) => ({ ...item }))
      if (input.estimates) decision.estimates = structuredClone(input.estimates)
      if (input.recommended) decision.recommended = structuredClone(input.recommended)
      // 合法动作集写在决策上（与 decisionState 通过 stateId 关联，读取侧按 id 拼装）
      ;(decision as AnalysisDecision & { legalActions?: AnalysisLegalAction[] }).legalActions =
        input.legalActions.map((action) => ({ ...action, ...(action.meld ? { meld: [...action.meld] } : {}) }))
    },

    source(input) {
      runtimeSources.set(key(input.windowId, input.seat), input.source)
      const decision = decisions.get(key(input.windowId, input.seat))
      if (decision) decision.source = input.source
    },

    chosen(input) {
      const decision = decisionFor(input.windowId, input.seat)
      if (!decision) return
      const legal = (decision as AnalysisDecision & { legalActions?: AnalysisLegalAction[] }).legalActions ?? []
      const picked = input.legalActionId === null ? null : legal.find((action) => action.id === input.legalActionId) ?? null
      const hasWinCandidate = legal.some((action) => WIN_KINDS.has(action.kind))
      const pickedIsWin = picked ? WIN_KINDS.has(picked.kind) : false
      decision.choice = picked ? { known: true, value: { legalActionId: picked.id, action: { ...picked } } } : UNKNOWN
      // 已经出现过带回退链的尝试时，即使调用方报的是 'model' 也要记成回退：
      // 否则"本地兜底的动作"会被归因成模型的选择（§4、§10.1）。
      const hadFallback = (decision.llmAttemptIds ?? []).some((id) => Boolean(attempts.get(id)?.fallback))
      const runtime = runtimeSources.get(key(input.windowId, input.seat))
      decision.source = runtime && input.source === 'unknown'
        ? runtime
        : input.source === 'model' && hadFallback ? 'model-fallback' : input.source
      if (input.commandId !== undefined) decision.execution.commandId = input.commandId
      decision.timing.submittedAt = input.at ?? monotonic()
      decision.timing.startedAt ??= decision.timing.windowOpenedAt
      decision.timing.completedAt = decision.timing.submittedAt
      decision.timing.computeMs = decision.timing.windowOpenedAt === undefined
        ? undefined
        : Math.max(0, decision.timing.submittedAt - decision.timing.windowOpenedAt)
      // 只有"当时存在合法胡牌候选且选择了别的动作"才算拒胡；不能把没观察到胡推断成主动过牌（§3.4）
      if (hasWinCandidate && picked && !pickedIsWin) decision.declinedWin = true
      if (picked && picked.kind === 'pass') decision.passed = true
      decisionCount += 1
      push('decision', structuredClone(decision))
    },

    receipt(input) {
      const decision = decisionFor(input.windowId, input.seat)
      if (!decision) return
      decision.execution.status = input.status
      if (input.eventId !== undefined) decision.execution.eventId = input.eventId
      if (input.detail !== undefined) decision.execution.detail = input.detail
      if (input.executedLegalActionId !== undefined) {
        decision.execution.executedLegalActionId = input.executedLegalActionId
      }
      push('decision', structuredClone(decision))
    },

    attemptStarted(input) {
      if (!enabled || paused) return ''
      const id = `attempt/${options.matchId}/${input.decisionWindowId}/${input.seat}/${input.attempt}`
      const attempt: AnalysisLlmAttempt = {
        id,
        decisionId: `decision/${options.matchId}/${input.decisionWindowId}/${input.seat}`,
        requestId: input.requestId,
        attempt: input.attempt,
        seat: input.seat,
        provider: input.provider,
        requestModel: input.requestModel,
        responseModel: UNKNOWN,
        sampling: { ...input.sampling },
        timing: {},
        outcome: 'success',
        ...(input.promptTemplateId ? { promptTemplateId: input.promptTemplateId } : {}),
        ...(input.promptVariables ? { promptVariables: structuredClone(input.promptVariables) } : {}),
      }
      attempt.timing.sentAt = input.sentAt ?? monotonic()
      attempts.set(id, attempt)
      attemptCount += 1
      const decision = decisions.get(key(input.decisionWindowId, input.seat))
      if (decision) {
        decision.llmAttemptIds = [...(decision.llmAttemptIds ?? []), id]
        decision.source = decision.source === 'unknown' ? 'model' : decision.source
      }
      return id
    },

    attemptFinished(attemptId, input) {
      const attempt = attempts.get(attemptId)
      if (!attempt) return
      attempt.outcome = input.outcome
      if (input.responseModel) attempt.responseModel = structuredClone(input.responseModel)
      if (input.answer) attempt.answer = structuredClone(input.answer)
      if (input.fallback) attempt.fallback = { ...input.fallback }
      if (input.usage) attempt.usage = { ...input.usage }
      if (input.firstByteAt !== undefined) attempt.timing.firstByteAt = input.firstByteAt
      attempt.timing.completedAt = input.completedAt ?? monotonic()
      if (attempt.timing.sentAt !== undefined) {
        attempt.timing.durationMs = Math.max(0, attempt.timing.completedAt - attempt.timing.sentAt)
      }
      // 回退链要落到决策来源上：避免把本地兜底动作归因于模型（§4）
      if (input.fallback) {
        const decision = decisions.get(`${attempt.decisionId}`)
        const byKey = [...decisions.values()].find((candidate) => candidate.llmAttemptIds?.includes(attemptId))
        const target = byKey ?? decision
        if (target && target.source === 'model') target.source = 'model-fallback'
      }
      push('llm', structuredClone(attempt))
    },

    settlement(input) {
      const record: AnalysisSettlement = { ...input, id: input.id ?? `settlement/${options.matchId}/${input.roundId}/${input.batchId}` }
      push('settlement', record)
    },

    reproduction(input) {
      push('reproduction', structuredClone(input))
    },

    noteGap(gap) {
      gaps.push({ ...gap })
      if (!enabled || paused) return
      push('gaps', { ...gap })
    },

    async flush(reason) {
      await flush(reason)
    },

    async finish() {
      if (!enabled) return { status: 'disabled' as AnalysisAreaStatus, bytes: 0 }
      await flush('finish')
      const storage = options.storage
      let bytes = 0
      if (storage?.available()) {
        const usage = await storage.usage()
        bytes = usage.bytes
        for (const gap of gaps) await storage.noteGap(options.matchId, gap)
        const meta = (await storage.read(options.matchId)).meta
        return { status: meta?.status ?? 'missing', bytes }
      }
      return { status: paused || gaps.length ? 'partial' : 'missing', bytes }
    },

    diagnostics() {
      return { decisions: decisionCount, attempts: attemptCount, pendingParts: pending.length, pendingBytes, paused }
    },
  }
}
