// Jev（System One）客户端 —— POST /v1/systemone。
//
// 与 TypeSafe 官方 API 及 OpenJev（wire 兼容实现）对接；与 chat 客户端（client.ts）的本质区别：
// - Jev **不生成文本**：对封闭候选集合返回概率分布（noul 是非 / choice 选择 / score 分级），
//   因此不存在「JSON 解析失败 → 语义重试」的路径；返回项不在白名单属于端点异常，直接抛错由调用方回退并记录来源。
// - choice 候选上限 255（官方限制）；score 层级 2–10。
// - state / criteria 允许字符串或 JSON 对象（OpenJev 文档口径），本客户端原样透传，不做二次序列化。
//
// 额度语义与 chat 客户端共用 providerAvailability（同一 baseUrl+key+model 共享暂停状态）：
// 官方 Jev API 是付费端点，402/403/429 + 明确额度文案时同样进入暂停；本地 OpenJev 不会触发。
import type { LlmOutput } from './schema'
import type { LlmProviderConfig } from './config'
import { LLM_CONNECTION_TEST_TIMEOUT_MS } from './config'
import { LlmClientError } from './client'
import { isQuotaExhaustedResponse, pauseQuota, probeQuotaConnection, quotaStatus } from './providerAvailability'

/** 官方 choice 候选上限（超过端点会拒绝，客户端提前拦截）。 */
export const JEV_MAX_CHOICE_OPTIONS = 255

export type JevState = string | Record<string, unknown> | unknown[]

export interface JevNoulQuestion { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
export interface JevChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
export interface JevScoreQuestion { type: 'score'; instructions: string; criteria: string[] }
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion

export interface JevRequest {
  state: JevState
  model: string
  questions: Record<string, JevQuestion>
}

/** 单个问题的回答（三种类型的字段并集；按实际类型只出现相应字段）。 */
export interface JevAnswer {
  /** noul：Yes 的概率（0–1）。 */
  noul?: number
  /** choice：选中的候选名。 */
  choice?: string
  /** score：概率加权的层级期望值（可为小数）。 */
  score?: number
  /** choice/score：候选集合上的概率分布。 */
  probabilities?: Record<string, number>
  /** score：层级说明回显。 */
  legend?: string[]
  /** choice/score：分布集中度（不是校准过的正确率）。 */
  confidence?: number
}

export interface JevResponse { answers: Record<string, JevAnswer> }

export interface JevCandidate {
  /** 候选 ID：作为 choice criteria 的键回显，必须与调用方的白名单一致。 */
  id: string
  /** 候选描述（criteria 值）；null 表示只给名字不给描述。 */
  description?: string | null
}

export interface JevDecisionOptions {
  config: LlmProviderConfig
  state: JevState
  instructions: string
  candidates: JevCandidate[]
  /** 主 choice 问题名（默认 'action'）；extras 不得与其重名。 */
  questionName?: string
  /** 附加问题（noul/score/choice）：同一请求一起下发，回答进 extras（不占额外延迟）。 */
  extras?: Record<string, JevQuestion>
  signal?: AbortSignal
  /** 请求体 model 字段覆盖（默认 config.model）。 */
  model?: string
}

/** 决策结果：LlmOutput 契约（choice 为候选 ID）+ Jev 特有的概率信息。 */
export interface JevDecisionResult extends LlmOutput {
  /** 主问题在候选集合上的概率分布（已过滤非数值项）。 */
  probabilities: Record<string, number>
  /** 主问题分布集中度；端点未给或非法时为 null。 */
  confidence: number | null
  /** 附加问题的回答（按问题名）。 */
  extras: Record<string, JevAnswer>
}

/**
 * System One 端点 URL 推导：安全规则与 normalizeBaseUrl 相同
 * （拒绝 userinfo；http 仅限 localhost/127.0.0.1，其余必须 https），路径统一为 /v1/systemone。
 */
export function normalizeSystemOneUrl(baseUrl: string): string | null {
  const value = baseUrl.trim()
  if (!value) return null
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null
  } catch {
    return null
  }
  const trimmed = value.replace(/\/+$/, '')
  if (trimmed.endsWith('/v1/systemone')) return trimmed
  return `${trimmed}/v1/systemone`
}

function sanitizeAnswer(value: unknown): JevAnswer | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const out: JevAnswer = {}
  if (typeof raw.noul === 'number' && Number.isFinite(raw.noul)) out.noul = raw.noul
  if (typeof raw.choice === 'string' && raw.choice) out.choice = raw.choice
  if (typeof raw.score === 'number' && Number.isFinite(raw.score)) out.score = raw.score
  if (raw.probabilities && typeof raw.probabilities === 'object') {
    const probabilities: Record<string, number> = {}
    for (const [name, probability] of Object.entries(raw.probabilities as Record<string, unknown>)) {
      if (typeof probability === 'number' && Number.isFinite(probability)) probabilities[name] = probability
    }
    out.probabilities = probabilities
  }
  if (Array.isArray(raw.legend)) {
    const legend = raw.legend.filter((level): level is string => typeof level === 'string')
    if (legend.length) out.legend = legend
  }
  if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) out.confidence = raw.confidence
  return out
}

/** 低层调用：一次 /v1/systemone 请求。网络/超时/HTTP/额度错误与 chat 客户端同一套 LlmClientError 分类。 */
export async function requestSystemOne(options: {
  config: LlmProviderConfig
  request: JevRequest
  signal?: AbortSignal
  /** 连接探测专用：probeQuotaConnection 注册期间 quotaStatus 为 'probing'，探测请求自身须绕过预检（与 callOnce 的 quotaProbe 同语义）。 */
  quotaProbe?: boolean
}): Promise<JevResponse> {
  const { config, request } = options
  if (!options.quotaProbe && quotaStatus(config) !== 'available') {
    throw new LlmClientError('quota-paused', '模型额度耗尽或正在重新连接，暂由本地 AI 接管')
  }
  const url = normalizeSystemOneUrl(config.baseUrl)
  if (!url) throw new LlmClientError('parse', 'baseUrl 非法（可能包含 userinfo 或不支持协议）')
  const controller = new AbortController()
  const timer = config.timeoutEnabled === false
    ? null
    : setTimeout(() => controller.abort(), config.timeoutMs)
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const apiKey = config.apiKey.trim()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 本地 OpenJev 未设 OPENJEV_API_KEY 时不校验凭证；空 key 就不发 Authorization 头。
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      if (isQuotaExhaustedResponse(response.status, body)) {
        pauseQuota(config)
        throw new LlmClientError('quota', '模型额度耗尽，已暂停此连接的请求，暂由本地 AI 接管')
      }
      throw new LlmClientError('http', `HTTP ${response.status}: ${body.slice(0, 200)}`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new LlmClientError('parse', 'API 响应不是有效 JSON')
    }
    const answers = (body as { answers?: unknown } | null)?.answers
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new LlmClientError('parse', 'API 响应缺少 answers 对象')
    }
    const sanitized: Record<string, JevAnswer> = {}
    for (const [name, value] of Object.entries(answers as Record<string, unknown>)) {
      const answer = sanitizeAnswer(value)
      if (answer) sanitized[name] = answer
    }
    return { answers: sanitized }
  } catch (error) {
    if (error instanceof LlmClientError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new LlmClientError('timeout', '请求超时或已取消')
    }
    throw new LlmClientError('network', `网络错误: ${String(error)}`)
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 决策请求：主 choice 问题（候选动作）+ 可选附加问题（noul/score）。
 * 选择结果映射进 LlmOutput 契约（choice=候选 ID，message 恒为空——Jev 不产文本）；
 * 概率分布与 confidence 单独返回，供分析记录与置信路由使用。
 */
export async function requestJevDecision(options: JevDecisionOptions): Promise<JevDecisionResult> {
  const questionName = options.questionName ?? 'action'
  const candidates = options.candidates
  if (!candidates.length) throw new LlmClientError('parse', '候选列表为空')
  if (candidates.length > JEV_MAX_CHOICE_OPTIONS) {
    throw new LlmClientError('parse', `候选数 ${candidates.length} 超过 Jev choice 上限 ${JEV_MAX_CHOICE_OPTIONS}`)
  }
  const criteria: Record<string, string | null> = {}
  for (const candidate of candidates) {
    if (!candidate.id) throw new LlmClientError('parse', '候选 ID 不能为空')
    if (candidate.id in criteria) throw new LlmClientError('parse', `候选 ID 重复：${candidate.id}`)
    criteria[candidate.id] = candidate.description ?? null
  }
  const questions: Record<string, JevQuestion> = {
    [questionName]: { type: 'choice', instructions: options.instructions, criteria },
  }
  for (const [name, question] of Object.entries(options.extras ?? {})) {
    if (name === questionName) throw new LlmClientError('parse', `附加问题不得与主问题重名：${name}`)
    if (question.type === 'score' && (question.criteria.length < 2 || question.criteria.length > 10)) {
      throw new LlmClientError('parse', `score 层级数必须在 2–10 之间：${name}`)
    }
    questions[name] = question
  }
  const response = await requestSystemOne({
    config: options.config,
    request: { state: options.state, model: options.model ?? options.config.model, questions },
    signal: options.signal,
  })
  const answer = response.answers[questionName]
  if (!answer || typeof answer.choice !== 'string') {
    throw new LlmClientError('parse', `响应缺少主问题 "${questionName}" 的 choice 回答`)
  }
  const candidateIds = candidates.map((candidate) => candidate.id)
  if (!candidateIds.includes(answer.choice)) {
    throw new LlmClientError('parse', `choice "${answer.choice}" 不在合法候选列表`)
  }
  const extras: Record<string, JevAnswer> = {}
  for (const [name, value] of Object.entries(response.answers)) {
    if (name !== questionName) extras[name] = value
  }
  return {
    choice: answer.choice,
    message: '',
    probabilities: answer.probabilities ?? {},
    confidence: answer.confidence ?? null,
    extras,
  }
}

/** 设置页「测试连接」：一次最小 noul 请求探测端点；不落日志、不回显 key。 */
export async function testJevConnection(config: LlmProviderConfig): Promise<{ ok: boolean; message: string }> {
  return probeQuotaConnection(config, async () => {
    try {
      await requestSystemOne({
        config: {
          ...config,
          timeoutMs: Math.min(config.timeoutMs, LLM_CONNECTION_TEST_TIMEOUT_MS),
          timeoutEnabled: true,
        },
        request: {
          state: 'ping',
          model: config.model,
          questions: { ping: { type: 'noul', instructions: 'Is this a connection test?' } },
        },
        quotaProbe: true,
      })
      return { ok: true, message: '连接成功' }
    } catch (error) {
      return { ok: false, message: error instanceof LlmClientError ? error.message : String(error) }
    }
  })
}
