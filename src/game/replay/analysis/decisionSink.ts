// 决策运行时 → 分析记录的窄接缝（方案 §3.3、§4）。
//
// 为什么单独一层：
// - 决策运行时（src/game/llm/bloodFlowRuntime.ts）不应该知道存储、字节预算、压缩这些事，
//   所以它只依赖这里定义的一个接口，且**不传时完全不调用**（零成本、零行为变化）。
// - 候选动作的 ID 空间必须与合法动作一致：运行时给出的候选带自己的 id，但窗口内稳定 ID 是
//   `windowId/下标`（见 bloodFlowAdapter），因此这里负责按动作内容把两边对上；对不上的候选
//   如实计入 unmapped，不猜测、不丢弃（§9.5 缺失要留痕）。
// - 接缝自身绝不抛错：任何异常都被吞掉并只通知一次，绝不能影响在飞的模型请求与对局（§9.5）。
import { legalActionId, normalizeAction, type BloodFlowActionLike } from './bloodFlowAdapter'
import type { AnalysisCandidate, AnalysisLegalAction, AnalysisLlmOutcome, AnalysisMaybe } from './types'

export interface BloodFlowCandidateLike {
  id: string
  action: BloodFlowActionLike
  /** 候选说明；若它影响模型选择，就属于输入的一部分（§4）。 */
  label?: string
  summary?: string
}

export interface BloodFlowRestrictedLike {
  action?: BloodFlowActionLike
  id?: string
  reason?: string
  /** 引擎/策略给出的限制原因码可能叫别的名字，宽松接收。 */
  code?: string
}

export interface BloodFlowDecisionSink {
  /** 候选集与被限制动作（§3.3）。legalActions 来自该座位的视角。 */
  candidates(input: {
    windowId: string
    seat: number
    legalActions: ReadonlyArray<BloodFlowActionLike>
    candidates: ReadonlyArray<BloodFlowCandidateLike>
    restricted?: ReadonlyArray<BloodFlowRestrictedLike>
    /** 真正发给这次请求的推荐（对应 request.engineSuggestion）。 */
    recommended?: { candidateId: string; note?: string }
  }): void
  /** 提示词模板：按版本去重存一次（§4）；决策只保存实际变量输入。 */
  promptTemplate(input: { id: string; content: unknown }): void
  /** 一次实际请求的开始；返回 attemptId（供结束时报回执）。 */
  attemptStarted(input: {
    windowId: string
    seat: number
    requestId: string
    attempt: number
    provider: string
    requestModel: string
    sampling: Record<string, unknown>
    promptTemplateId?: string
    promptVariables?: Record<string, unknown>
  }): string
  attemptFinished(attemptId: string, input: {
    outcome: AnalysisLlmOutcome
    responseModel?: AnalysisMaybe<string>
    /** 最终回答（模型输出给应用的决策内容，不是内部思考）。 */
    answer?: AnalysisMaybe<{ text: string; candidateId?: string; note?: string }>
    fallback?: { reason: string; strategy: string; legalActionId?: string }
    usage?: Record<string, number>
  }): void
  /** 这一手的来源：本地策略／模型／模型失败后的本地回退（§3.4）。 */
  source(input: { windowId: string; seat: number; source: 'local-strategy' | 'model' | 'model-fallback'; reason?: string }): void
}

/** 运行时需要的分析记录能力（由 createAnalysisRecorder 提供，这里只取用到的部分）。 */
export interface DecisionAnalysisRecorder {
  candidates(input: {
    windowId: string; seat: number; legalActions: AnalysisLegalAction[]
    candidates: AnalysisCandidate[]; restricted?: Array<{ legalActionId: string; reason: string }>
    recommended?: AnalysisMaybe<{ legalActionId: string; note?: string }>
  }): void
  attemptStarted(input: {
    decisionWindowId: string; seat: number; requestId: string; attempt: number
    provider: string; requestModel: string; sampling: Record<string, unknown>
    promptTemplateId?: string; promptVariables?: Record<string, unknown>
  }): string
  attemptFinished(attemptId: string, input: {
    outcome: AnalysisLlmOutcome
    responseModel?: AnalysisMaybe<string>
    answer?: AnalysisMaybe<{ text: string; candidateId?: string; note?: string }>
    fallback?: { reason: string; strategy: string; legalActionId?: string }
    usage?: Record<string, number>
  }): void
  /** 运行时确定的来源；之后的 chosen() 不得用 'unknown' 覆盖它（§3.4）。 */
  source(input: { windowId: string; seat: number; source: 'local-strategy' | 'model' | 'model-fallback'; reason?: string }): void
  /** 提示词模板：按版本去重存一次（§4）。 */
  promptTemplate(input: { id: string; content: unknown }): void
}

export interface DecisionSinkOptions {
  recorder: DecisionAnalysisRecorder
  /** 不可用时返回 null，则所有调用直接空转（零成本）。 */
  enabled?: boolean
  onError?: (detail: string) => void
}

/** 把候选动作按内容对到窗口内的合法动作下标上（与 send() 的相等性口径一致）。 */
export function mapCandidatesToLegalActions(
  windowId: string,
  legalActions: ReadonlyArray<BloodFlowActionLike>,
  candidates: ReadonlyArray<BloodFlowCandidateLike>,
): { candidates: AnalysisCandidate[]; unmapped: number } {
  const canonical = legalActions.map((action, index) => ({ index, json: JSON.stringify(action) }))
  const mapped: AnalysisCandidate[] = []
  let unmapped = 0
  for (const candidate of candidates) {
    const json = JSON.stringify(candidate.action)
    const hit = canonical.find((item) => item.json === json)
    if (!hit) { unmapped += 1; continue }
    mapped.push({
      legalActionId: legalActionId(windowId, hit.index),
      action: normalizeAction(windowId, hit.index, candidate.action),
    })
  }
  return { candidates: mapped, unmapped }
}

/**
 * 创建面向决策运行时的接缝。
 * 所有调用都包在 try/catch 里：接缝出错只会通知一次，绝不冒泡到模型请求路径（§9.5）。
 */
export function createBloodFlowDecisionSink(options: DecisionSinkOptions): BloodFlowDecisionSink {
  const enabled = options.enabled !== false
  const attempts = new Map<string, { windowId: string; seat: number }>()
  let reported = false

  function safe(run: () => void, label: string) {
    if (!enabled) return
    try {
      run()
    } catch (error) {
      if (reported) return
      reported = true
      try { options.onError?.(`分析接缝 ${label} 失败：${String(error).slice(0, 160)}`) } catch { /* 通知自身也要安全 */ }
    }
  }

  return {
    candidates(input) {
      safe(() => {
        const { candidates, unmapped } = mapCandidatesToLegalActions(input.windowId, input.legalActions, input.candidates)
        const restricted = (input.restricted ?? [])
          .map((item) => {
            if (!item.action) return null
            const json = JSON.stringify(item.action)
            const index = input.legalActions.findIndex((action) => JSON.stringify(action) === json)
            if (index < 0) return null
            return { legalActionId: legalActionId(input.windowId, index), reason: item.reason ?? item.code ?? 'restricted' }
          })
          .filter((item): item is { legalActionId: string; reason: string } => item !== null)
        // 对不上的候选只计数（由调用方在 gap 里留痕），不猜测其合法动作 ID、也不静默当成空集
        options.recorder.candidates({
          windowId: input.windowId, seat: input.seat,
          legalActions: input.legalActions.map((action, index) => normalizeAction(input.windowId, index, action)),
          candidates,
          ...(restricted.length ? { restricted } : {}),
          ...(input.recommended
            ? (() => {
              const json = JSON.stringify(input.candidates.find((candidate) => candidate.id === input.recommended!.candidateId)?.action ?? null)
              const index = input.legalActions.findIndex((action) => JSON.stringify(action) === json)
              return index >= 0
                ? { recommended: { known: true as const, value: { legalActionId: legalActionId(input.windowId, index), ...(input.recommended.note ? { note: input.recommended.note } : {}) } } }
                : {}
            })()
            : {}),
        })
        if (unmapped > 0) {
          options.onError?.(`有 ${unmapped} 个候选无法对应到合法动作（未记录其合法 ID）`)
        }
      }, 'candidates')
    },

    promptTemplate(input) {
      if (!enabled) return
      safe(() => { options.recorder.promptTemplate(input) }, 'promptTemplate')
    },

    attemptStarted(input) {
      if (!enabled) return ''
      try {
        const id = options.recorder.attemptStarted({
          decisionWindowId: input.windowId, seat: input.seat, requestId: input.requestId, attempt: input.attempt,
          provider: input.provider, requestModel: input.requestModel, sampling: input.sampling,
          ...(input.promptTemplateId ? { promptTemplateId: input.promptTemplateId } : {}),
          ...(input.promptVariables ? { promptVariables: input.promptVariables } : {}),
        })
        attempts.set(id, { windowId: input.windowId, seat: input.seat })
        return id
      } catch (error) {
        if (!reported) { reported = true; try { options.onError?.(`分析接缝 attemptStarted 失败：${String(error).slice(0, 160)}`) } catch { /* noop */ } }
        return ''
      }
    },

    attemptFinished(attemptId, input) {
      if (!enabled || !attemptId || !attempts.has(attemptId)) return
      safe(() => {
        options.recorder.attemptFinished(attemptId, input)
        attempts.delete(attemptId)
      }, 'attemptFinished')
    },

    source(input) {
      safe(() => { options.recorder.source(input) }, 'source')
    },
  }
}
