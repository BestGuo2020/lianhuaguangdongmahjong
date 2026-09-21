// 分析录制会话：把"每场一个新录制器"藏在一个**稳定代理**后面（§3.1、§9.2）。
//
// 为什么需要它：引擎在创建时拿到的是 `analysis?: AnalysisRecorder | null`（一个值），
// 而匹配 id／配置是每场才确定的。于是给引擎一个永不失效的代理，换场时只换内部目标：
// 引擎无需重建、也不会把上一场的记录混进新场。
//
// 会议层同时负责：场次配置（引擎/规则/AI 指纹、座位控制）、场末收尾落库、
// 以及"分析关闭时零成本"（enabled=false 时所有调用直接空转，不产生任何分配与写入）。
import { fingerprintOf } from './codec'
import type { StorageCapability } from './capability'
import { createAnalysisRecorder, type AnalysisMatchInput, type AnalysisRecorder } from './recorder'
import type { AnalysisStorage } from './storage'
import type { AnalysisAreaStatus, AnalysisSeatControl } from './types'

export interface AnalysisSessionOptions {
  enabled: boolean
  storage?: AnalysisStorage | null
  now?: () => number
  monotonic?: () => number
  /** 场次 id 生成（默认随机）。 */
  createId?: () => string
  onError?: (detail: string) => void
}

export interface AnalysisSession {
  /** 传给引擎的稳定代理；分析关闭时是 null（引擎侧零成本）。 */
  readonly port: AnalysisRecorder | null
  enabled(): boolean
  /** 开一场：创建新的录制器并写入场次配置。返回场次 id。 */
  start(input: {
    matchId?: string
    rulesetId: string
    rules: unknown
    rulesVersion: string
    aiConfig: unknown
    aiStrategy: string
    seatControl: AnalysisSeatControl[]
    engineBuild?: string
    models?: AnalysisMatchInput['models']
    promptTemplates?: AnalysisMatchInput['promptTemplates']
  }): string
  /** 场末收尾：刷队列、写缺失、返回分析区状态。 */
  finish(): Promise<{ matchId: string; status: AnalysisAreaStatus; bytes: number }>
  /** 当前（或最近一场）的场次 id。 */
  matchId(): string
  /** 引擎等外部组件持有的代理若未被创建（关闭态），返回 false。 */
  active(): boolean
  /** 浏览器存储能力（§9.4／§10.11）；未接存储时为 null。 */
  capability(): StorageCapability | null
}

function defaultId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `analysis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 创建分析会话。
 * `enabled: false` 时 `port` 为 null —— 调用方传进引擎后整条路径零成本（§9.2、§10.7）。
 */
export function createAnalysisSession(options: AnalysisSessionOptions): AnalysisSession {
  const enabled = options.enabled
  const now = options.now ?? (() => Date.now())
  const createId = options.createId ?? defaultId
  let target: AnalysisRecorder | null = null
  let currentMatchId = ''
  let lastStatus: AnalysisAreaStatus = enabled ? 'missing' : 'disabled'

  /** 稳定代理：引擎持有它，换场只换 target。 */
  const port: AnalysisRecorder | null = enabled ? {
    get enabled() { return target?.enabled ?? false },
    paused: () => target?.paused() ?? false,
    beginMatch: (input) => target?.beginMatch(input) ?? '',
    windowOpened: (input) => target?.windowOpened(input),
    candidates: (input) => target?.candidates(input),
    promptTemplate: (input) => target?.promptTemplate(input),
    chosen: (input) => target?.chosen(input),
    source: (input) => target?.source(input),
    receipt: (input) => target?.receipt(input),
    attemptStarted: (input) => target?.attemptStarted(input) ?? '',
    attemptFinished: (attemptId, input) => target?.attemptFinished(attemptId, input),
    settlement: (input) => target?.settlement(input),
    reproduction: (input) => target?.reproduction(input),
    noteGap: (gap) => target?.noteGap(gap),
    flush: async (reason) => { await target?.flush(reason) },
    // 与 session.finish() 同一实现：引擎侧调它（中途退出）时同样会结束本场，避免下一场错场归属
    finish: async () => {
      const result = await finishMatch()
      return { status: result.status, bytes: result.bytes }
    },
    diagnostics: () => target?.diagnostics() ?? { decisions: 0, attempts: 0, pendingParts: 0, pendingBytes: 0, paused: false },
  } : null

  /**
   * 结束当前场次：刷队列 → 写缺失 → **清空 target**（下一场靠 `start()` 新建录制器）。
   *
   * 代理与 `session.finish()` 共用它：引擎侧在"中途退出"时也会调 `port.finish()`，
   * 若只结束录制器而不清 target，会话会一直是 active —— App 的 `analysis.active()` 守卫
   * 会跳过下一场的 `start()`，于是新对局的记录挂到上一场的 matchId 上（错场归属）。
   */
  async function finishMatch(): Promise<{ matchId: string; status: AnalysisAreaStatus; bytes: number }> {
    const recorder = target
    const matchId = currentMatchId
    target = null
    // 场末按 §9.4 复检一次同源容量（有节制的检查；不用它的读数覆盖逐块账本）
    void options.storage?.capability?.().refreshEstimate().catch(() => {})
    if (!recorder) return { matchId, status: lastStatus, bytes: 0 }
    const result = await recorder.finish()
    lastStatus = result.status
    return { matchId, status: result.status, bytes: result.bytes }
  }

  return {
    port,
    enabled: () => enabled,
    active: () => Boolean(target),
    matchId: () => currentMatchId,

    start(input) {
      if (!enabled || !port) return ''
      currentMatchId = input.matchId ?? createId()
      target = createAnalysisRecorder({
        enabled: true,
        matchId: currentMatchId,
        rulesetId: input.rulesetId,
        storage: options.storage ?? null,
        now,
        ...(options.monotonic ? { monotonic: options.monotonic } : {}),
        ...(options.onError ? { onError: options.onError } : {}),
      })
      lastStatus = 'complete'
      // §9.4：首次启用分析录制时检查持久化状态，未持久化就在这次明确操作里申请一次 persist()。
      // 失败/被拒都只记录状态，不影响录制；也不会每次开局反复申请（探测模块自己记住）。
      void options.storage?.capability?.().ensurePersistence().catch(() => {})
      target.beginMatch({
        engineBuild: input.engineBuild ?? 'lianhua-guangma@local',
        rulesVersion: input.rulesVersion,
        rulesFingerprint: fingerprintOf(input.rules),
        rules: (input.rules ?? {}) as Record<string, unknown>,
        aiStrategy: input.aiStrategy,
        aiFingerprint: fingerprintOf(input.aiConfig),
        aiConfig: (input.aiConfig ?? {}) as Record<string, unknown>,
        seatControl: [...input.seatControl],
        ...(input.models ? { models: input.models } : {}),
        ...(input.promptTemplates ? { promptTemplates: input.promptTemplates } : {}),
      })
      return currentMatchId
    },

    async finish() {
      return await finishMatch()
    },
    /** 浏览器存储能力快照（持久化状态 + 最近一次容量估算），供诊断/容量基线工具读取。 */
    capability() {
      return options.storage?.capability?.() ?? null
    },
  }
}

/** 场次完成后按展示回放清单回收悬空分析区（§9.2：分析不得比展示回放活得更久）。 */
export async function reconcileAnalysisWithReplay(
  storage: AnalysisStorage | null | undefined,
  /** 仍然存在的展示回放场次 id。 */
  replayMatchIds: readonly string[],
): Promise<string[]> {
  if (!storage?.available()) return []
  return storage.reconcileLifecycle([...replayMatchIds])
}
