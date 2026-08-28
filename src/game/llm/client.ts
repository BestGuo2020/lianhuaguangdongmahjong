// OpenAI 兼容客户端 —— docs/llm-ai-design.md §7.2/§7.3/§10。
// 纯文本 prompt + JSON 输出（不用 function calling）；解析容错（平衡括号扫描）；
// 仅「JSON 解析失败 / choice 不在白名单」允许一次语义重试；网络/超时/HTTP 直接抛错（不回退语义重试）。
import type { LlmOutput } from './schema'
import type { LlmProviderConfig } from './config'
import { normalizeBaseUrl, QWEN_DECISION_TIMEOUT_MS } from './config'
import { withFeedbackRetry } from './prompt'
import { reasoningPolicyUsable, resolveReasoningPolicy } from './reasoningPolicy'

export class LlmClientError extends Error {
  constructor(
    readonly kind: 'http' | 'timeout' | 'network' | 'parse' | 'config' | 'reasoning',
    message: string,
  ) {
    super(message)
    this.name = 'LlmClientError'
  }
}

interface ChatMessage { role: 'system' | 'user'; content: string }

export interface PromptPair { system: string; user: string }

export interface LlmDecisionOptions {
  config: LlmProviderConfig
  messages: PromptPair
  /** 候选编号白名单（语义校验 + 重试反馈用） */
  candidateIds: string[]
  /** 信号：取消/换局时中止（AbortController 透传） */
  signal?: AbortSignal
  /** 由协调器判定后的深度思考调用；推理字段只用于供应商，不进入展示层。 */
  reasoning?: boolean
  /** 深度思考硬截止时间；超时由控制器回退本地引擎。 */
  deadlineMs?: number
}

interface ChatResponse {
  content: string
  finishReason: string | null
}

/**
 * 平衡括号扫描器：提取文本中第一个完整的 JSON 对象。
 * 必须维护 inString/escaped 状态 —— 字符串字面量内的 { } " \ 不参与括号平衡（§7.2）。
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

/** 解析 LLM 原始回复 → {choice, message}；任意失败抛 LlmParseError（触发一次语义重试）。 */
export function parseLlmOutput(raw: string, candidateIds: string[]): LlmOutput {
  if (!raw || !raw.trim()) throw new LlmClientError('parse', '回复为空')
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '')
  }
  let obj: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>
  } catch {
    const extracted = extractJsonObject(text)
    if (extracted !== null) {
      try { obj = JSON.parse(extracted) as Record<string, unknown> } catch { obj = null }
    }
  }
  if (!obj) throw new LlmClientError('parse', '未找到有效 JSON 对象')
  const choice = obj.choice
  if (typeof choice !== 'string' || !choice) throw new LlmClientError('parse', 'choice 缺失或非字符串')
  if (!candidateIds.includes(choice)) {
    throw new LlmClientError('parse', `choice "${choice}" 不在合法候选列表`)
  }
  const message = typeof obj.message === 'string' ? cleanMessage(obj.message) : ''
  return { choice, message }
}

/** Unicode code point 截断 30 字 + 移除控制字符（§7.2 第 3 条）。 */
export function cleanMessage(text: string): string {
  const cleaned = [...text.replace(/[\u0000-\u001f\u007f]/g, '')].slice(0, 30).join('')
  return cleaned.trim()
}

interface CallOnceOptions {
  maxTokens?: number
  /** 连接测试等场景：finish_reason=length 视为成功（证明链路通畅，仅内容被截断） */
  strictLength?: boolean
  /** 追加到请求体的供应商能力矩阵字段。 */
  extraBody?: Record<string, unknown>
  allowReasoning?: boolean
}

/** 百炼 Qwen 3.5–3.8 默认开启混合思考；麻将候选选择使用非思考模式。 */
export function isQwenThinkingModel(config: Pick<LlmProviderConfig, 'baseUrl' | 'model'>): boolean {
  const resolved = resolveReasoningPolicy(config)
  return resolved.providerType === 'qwen' && resolved.mode === 'explicit-off'
}

export function effectiveDecisionTimeoutMs(config: LlmProviderConfig): number {
  return isQwenThinkingModel(config)
    ? Math.min(config.timeoutMs, QWEN_DECISION_TIMEOUT_MS)
    : config.timeoutMs
}

function providerExtraBody(
  config: LlmProviderConfig,
  structuredOutput: boolean,
  reasoning = false,
): Record<string, unknown> | undefined {
  const resolved = resolveReasoningPolicy(config, reasoning)
  if (!reasoningPolicyUsable(resolved)) throw new LlmClientError('config', resolved.message)
  const body: Record<string, unknown> = { ...resolved.requestBody }
  if (resolved.providerType === 'qwen' && structuredOutput) body.response_format = { type: 'json_object' }
  return Object.keys(body).length ? body : undefined
}

/** Anthropic 官方端点：浏览器直连需携带 anthropic-dangerous-direct-browser-access 头。 */
export function isAnthropicBaseUrl(baseUrl: string): boolean {
  return /^https:\/\/api\.anthropic\.com/i.test(baseUrl.trim())
}

async function callOnce(
  config: LlmProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  options: CallOnceOptions = {},
): Promise<ChatResponse> {
  const url = normalizeBaseUrl(config.baseUrl)
  if (!url) throw new LlmClientError('parse', 'baseUrl 非法（可能包含 userinfo 或不支持协议）')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        ...(isAnthropicBaseUrl(config.baseUrl) ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.4,
        ...(options.allowReasoning && resolveReasoningPolicy(config).providerType === 'openai'
          ? { max_completion_tokens: options.maxTokens ?? 512 }
          : { max_tokens: options.maxTokens ?? 64 }),
        top_p: 1,
        stream: false,
        n: 1,
        ...(options.extraBody ?? {}),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new LlmClientError('http', `HTTP ${response.status}: ${detail}`)
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string | null }>
      reasoning?: unknown
      usage?: { completion_tokens_details?: { reasoning_tokens?: unknown } }
    }
    const choice = body.choices?.[0]
    if (!choice?.message || typeof choice.message.content !== 'string' || !choice.message.content) {
      throw new LlmClientError('parse', 'API 响应格式无效或无内容')
    }
    if (choice.finish_reason === 'length' && options.strictLength !== false) {
      throw new LlmClientError('parse', 'finish_reason=length（输出被截断）')
    }
    const reasoningContent = choice.message.reasoning_content
    const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens
    const leakedReasoning = (typeof reasoningContent === 'string' && reasoningContent.trim().length > 0)
      || (typeof reasoningTokens === 'number' && reasoningTokens > 0)
      || (typeof body.reasoning === 'string' && body.reasoning.trim().length > 0)
      || (Array.isArray(body.reasoning) && body.reasoning.length > 0)
    if (leakedReasoning && !options.allowReasoning) {
      throw new LlmClientError('reasoning', '供应商仍返回思考内容，非思考模式验证失败')
    }
    return { content: choice.message.content, finishReason: choice.finish_reason ?? null }
  } catch (error) {
    if (error instanceof LlmClientError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new LlmClientError('timeout', '请求超时或已取消')
    }
    throw new LlmClientError('network', `网络错误: ${String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 决策请求：一次语义重试（解析/白名单失败）；网络/超时/HTTP 直接抛错。
 * 快速路径总预算 = config.timeoutMs；条件深思使用独立 deadlineMs（含语义重试）。
 */
export async function requestLlmDecision(options: LlmDecisionOptions): Promise<LlmOutput> {
  const budgetMs = options.reasoning
    ? (options.deadlineMs ?? options.config.timeoutMs)
    : effectiveDecisionTimeoutMs(options.config)
  const startedAt = Date.now()
  const attempt = async (messages: PromptPair, errorForRetry?: string): Promise<LlmOutput> => {
    const left = budgetMs - (Date.now() - startedAt)
    if (left <= 0) throw new LlmClientError('timeout', '总预算耗尽')
    const config = { ...options.config, timeoutMs: left }
    const extraBody = providerExtraBody(config, true, options.reasoning === true)
    try {
      const response = await callOnce(
        config,
        [{ role: 'system', content: messages.system }, { role: 'user', content: messages.user }],
        options.signal,
        { extraBody, allowReasoning: options.reasoning, maxTokens: options.reasoning ? 512 : undefined },
      )
      return parseLlmOutput(response.content, options.candidateIds)
    } catch (error) {
      if (error instanceof LlmClientError && error.kind === 'parse' && !errorForRetry) {
        const retry = withFeedbackRetry(messages.system, messages.user, error.message, options.candidateIds)
        return attempt(retry, error.message)
      }
      throw error
    }
  }
  return attempt(options.messages)
}

/** 设置页「测试连接」（§9.1）：探测供应商可用性；Key 不回显、不落日志。
 * 连接测试只看「是否连通且有内容」：finish_reason=length 不算失败
 * （模型回一大段话被 max_tokens 截断恰恰证明链路通畅）。 */
export async function testLlmConnection(config: LlmProviderConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const effectiveConfig = { ...config, timeoutMs: effectiveDecisionTimeoutMs(config) }
    await callOnce(
      effectiveConfig,
      [{ role: 'system', content: 'ping' }, { role: 'user', content: 'ping' }],
      undefined,
      {
        maxTokens: 8,
        strictLength: false,
        extraBody: providerExtraBody(effectiveConfig, false),
      },
    )
    return { ok: true, message: '连接成功' }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof LlmClientError ? error.message : String(error),
    }
  }
}
