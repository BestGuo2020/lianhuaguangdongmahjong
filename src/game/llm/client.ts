// OpenAI 兼容客户端 —— docs/llm-ai-design.md §7.2/§7.3/§10。
// 纯文本 prompt + JSON 输出（不用 function calling）；解析容错（平衡括号扫描）；
// 仅「JSON 解析失败 / choice 不在白名单」允许一次语义重试；网络/超时/HTTP 直接抛错（不回退语义重试）。
import type { LlmOutput } from './schema'
import type { LlmProviderConfig } from './config'
import { LLM_CONNECTION_TEST_TIMEOUT_MS, normalizeBaseUrl } from './config'
import { withFeedbackRetry } from './prompt'
import { resolveReasoningPolicy } from './reasoningPolicy'

export class LlmClientError extends Error {
  constructor(
    readonly kind: 'http' | 'timeout' | 'network' | 'parse' | 'reasoning' | 'length',
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
  /** 由协调器判定后的深度思考调用。 */
  reasoning?: boolean
  /** 深度思考硬截止时间；超时由控制器回退本地引擎。 */
  deadlineMs?: number
  /** OpenAI 兼容 SSE 到达推理块时的安全进度脉冲；绝不向上暴露块内容。 */
  onReasoningProgress?: () => void
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
  /** 连接测试可用空 content 判定链路已连通。 */
  allowEmptyContent?: boolean
  /** 追加到请求体的供应商能力矩阵字段。 */
  extraBody?: Record<string, unknown>
  allowReasoning?: boolean
  /** 只放宽响应验证，不改变请求参数。 */
  acceptReasoningResponse?: boolean
  /** 只通知推理块到达；原始推理与最终 content 都不会通过回调向上暴露。 */
  onReasoningProgress?: () => void
}

/** 百炼 Qwen 3.5–3.8 默认开启混合思考；麻将候选选择使用非思考模式。 */
export function isQwenThinkingModel(config: Pick<LlmProviderConfig, 'baseUrl' | 'model'>): boolean {
  const resolved = resolveReasoningPolicy(config)
  return resolved.providerType === 'qwen' && resolved.mode === 'explicit-off'
}

export function effectiveDecisionTimeoutMs(config: LlmProviderConfig): number {
  return config.timeoutEnabled === false ? Number.POSITIVE_INFINITY : config.timeoutMs
}

function providerExtraBody(
  config: LlmProviderConfig,
  structuredOutput: boolean,
  reasoning = false,
): Record<string, unknown> | undefined {
  const resolved = resolveReasoningPolicy(config, reasoning)
  const body: Record<string, unknown> = { ...resolved.requestBody }
  const modelName = config.model.trim().toLowerCase().split('/').pop() ?? ''
  if (structuredOutput && (resolved.providerType === 'qwen'
    || (resolved.providerType === 'glm' && /^glm-5\.3-flash(?:[.-]|$)/.test(modelName)))) {
    body.response_format = { type: 'json_object' }
  }
  return Object.keys(body).length ? body : undefined
}

/** Anthropic 官方端点：浏览器直连需携带 anthropic-dangerous-direct-browser-access 头。 */
export function isAnthropicBaseUrl(baseUrl: string): boolean {
  return /^https:\/\/api\.anthropic\.com/i.test(baseUrl.trim())
}

interface OpenAIResponseBody {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown }
    delta?: {
      content?: unknown
      reasoning_content?: unknown
      reasoning?: unknown
      thinking?: unknown
    }
    finish_reason?: string | null
  }>
  reasoning?: unknown
  usage?: { completion_tokens_details?: { reasoning_tokens?: unknown } }
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textValue).join('')
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
  }
  return ''
}

function reasoningDeltaOf(body: OpenAIResponseBody): string {
  const delta = body.choices?.[0]?.delta
  return textValue(delta?.reasoning_content)
    || textValue(delta?.reasoning)
    || textValue(delta?.thinking)
    || textValue(body.reasoning)
}

/** 读取 OpenAI 兼容的 SSE；content 与 reasoning 使用独立缓冲，避免半截 JSON 被提前执行。 */
async function readStreamingResponse(
  response: Response,
  options: CallOnceOptions,
): Promise<ChatResponse> {
  if (!response.body) throw new LlmClientError('parse', 'API 流式响应缺少响应体')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  let dataLines: string[] = []
  let content = ''
  let finishReason: string | null = null
  let reasoningTokens = 0
  let sawReasoning = false
  let sawData = false

  const processEvent = () => {
    if (!dataLines.length) return
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (!data || data === '[DONE]') return
    let body: OpenAIResponseBody
    try {
      body = JSON.parse(data) as OpenAIResponseBody
    } catch {
      throw new LlmClientError('parse', 'API 流式响应包含无效 JSON')
    }
    sawData = true
    const choice = body.choices?.[0]
    const contentDelta = choice?.delta?.content
    if (typeof contentDelta === 'string') content += contentDelta
    const reasoningDelta = reasoningDeltaOf(body)
    if (reasoningDelta) {
      sawReasoning = true
      try { options.onReasoningProgress?.() } catch { /* 展示回调不能中断模型响应 */ }
    }
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
    const tokens = body.usage?.completion_tokens_details?.reasoning_tokens
    if (typeof tokens === 'number' && Number.isFinite(tokens)) reasoningTokens = Math.max(reasoningTokens, tokens)
  }

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) {
      processEvent()
      return
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    lineBuffer += decoder.decode(value, { stream: true })
    let newline = lineBuffer.indexOf('\n')
    while (newline >= 0) {
      processLine(lineBuffer.slice(0, newline))
      lineBuffer = lineBuffer.slice(newline + 1)
      newline = lineBuffer.indexOf('\n')
    }
  }
  lineBuffer += decoder.decode()
  if (lineBuffer) processLine(lineBuffer)
  processEvent()

  if (!sawData) throw new LlmClientError('parse', 'API 流式响应没有有效数据')
  if (finishReason === 'length' && options.strictLength !== false) {
    throw new LlmClientError('length', 'finish_reason=length（输出被截断）')
  }
  if (!content && options.allowEmptyContent !== true) {
    throw new LlmClientError('parse', 'API 响应格式无效或无内容')
  }
  if ((sawReasoning || reasoningTokens > 0) && !options.allowReasoning && !options.acceptReasoningResponse) {
    throw new LlmClientError('reasoning', '供应商仍返回思考内容，非思考模式验证失败')
  }
  return { content, finishReason }
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
  const timer = config.timeoutEnabled === false
    ? null
    : setTimeout(() => controller.abort(), config.timeoutMs)
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const resolvedProvider = resolveReasoningPolicy(config).providerType
  const modelName = config.model.trim().toLowerCase().split('/').pop() ?? ''
  const omitDefaultSampling = (resolvedProvider === 'claude'
    && /^claude-sonnet-5(?:[.-]|$)/.test(modelName))
    || (resolvedProvider === 'kimi' && /^kimi-k3(?:[.-]|$)/.test(modelName))
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
        ...(omitDefaultSampling ? {} : { temperature: 0.4, top_p: 1 }),
        ...(options.allowReasoning && resolvedProvider === 'openai'
          ? { max_completion_tokens: options.maxTokens ?? 512 }
          : { max_tokens: options.maxTokens ?? 64 }),
        stream: true,
        n: 1,
        ...(options.extraBody ?? {}),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new LlmClientError('http', `HTTP ${response.status}: ${detail}`)
    }
    // 标准路径始终读取 SSE；少数兼容端点会忽略 stream=true 并退回普通 JSON，继续兼容。
    const contentType = response.headers?.get?.('content-type') ?? ''
    const hasReadableBody = Boolean(response.body && typeof response.body.getReader === 'function')
    if (hasReadableBody && !/application\/json/i.test(contentType)) {
      return await readStreamingResponse(response, options)
    }
    const body = (await response.json()) as OpenAIResponseBody
    const choice = body.choices?.[0]
    if (choice?.finish_reason === 'length' && options.strictLength !== false) {
      throw new LlmClientError('length', 'finish_reason=length（输出被截断）')
    }
    if (!choice?.message
      || typeof choice.message.content !== 'string'
      || (!choice.message.content && options.allowEmptyContent !== true)) {
      throw new LlmClientError('parse', 'API 响应格式无效或无内容')
    }
    const reasoningContent = choice.message.reasoning_content
    const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens
    const leakedReasoning = (typeof reasoningContent === 'string' && reasoningContent.trim().length > 0)
      || (typeof reasoningTokens === 'number' && reasoningTokens > 0)
      || (typeof body.reasoning === 'string' && body.reasoning.trim().length > 0)
      || (Array.isArray(body.reasoning) && body.reasoning.length > 0)
    if (leakedReasoning && !options.allowReasoning && !options.acceptReasoningResponse) {
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
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 决策请求：一次语义重试（解析/白名单失败）；网络/超时/HTTP 直接抛错。
 * 快速路径总预算 = config.timeoutMs；条件深思使用独立 deadlineMs（含语义重试）。
 */
export async function requestLlmDecision(options: LlmDecisionOptions): Promise<LlmOutput> {
  const budgetMs = options.config.timeoutEnabled === false
    ? Number.POSITIVE_INFINITY
    : options.reasoning
      ? (options.deadlineMs ?? options.config.timeoutMs)
      : effectiveDecisionTimeoutMs(options.config)
  const startedAt = Date.now()
  const attempt = async (messages: PromptPair, errorForRetry?: string): Promise<LlmOutput> => {
    const left = budgetMs - (Date.now() - startedAt)
    if (left <= 0) throw new LlmClientError('timeout', '总预算耗尽')
    const config = { ...options.config, timeoutMs: left }
    const reasoningPolicy = resolveReasoningPolicy(config, options.reasoning === true)
    const alwaysThinking = reasoningPolicy.mode === 'always-on'
    const modelName = config.model.trim().toLowerCase().split('/').pop() ?? ''
    const glmFlash = reasoningPolicy.providerType === 'glm'
      && /^glm-5\.3-flash(?:[.-]|$)/.test(modelName)
    const quickReasoningMaxTokens = options.reasoning !== true
      ? (glmFlash ? 512
        : reasoningPolicy.providerType === 'kimi' && /^kimi-k3(?:[.-]|$)/.test(modelName) ? 128 : undefined)
      : undefined
    const deepReasoningMaxTokens = glmFlash ? 1024 : 512
    const acceptReasoningResponse = options.reasoning === true
      || alwaysThinking
      || reasoningPolicy.acceptReasoningResponse
    const extraBody = providerExtraBody(config, true, options.reasoning === true)
    try {
      const response = await callOnce(
        config,
        [{ role: 'system', content: messages.system }, { role: 'user', content: messages.user }],
        options.signal,
        {
          extraBody,
          allowReasoning: options.reasoning === true || alwaysThinking,
          acceptReasoningResponse,
          maxTokens: options.reasoning
            ? deepReasoningMaxTokens
            : (quickReasoningMaxTokens ?? (alwaysThinking ? 512 : undefined)),
          onReasoningProgress: options.onReasoningProgress,
        },
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
    const effectiveConfig = {
      ...config,
      timeoutMs: Math.min(config.timeoutMs, LLM_CONNECTION_TEST_TIMEOUT_MS),
      timeoutEnabled: true,
    }
    const reasoningPolicy = resolveReasoningPolicy(effectiveConfig)
    const alwaysThinking = reasoningPolicy.mode === 'always-on'
    const modelName = effectiveConfig.model.trim().toLowerCase().split('/').pop() ?? ''
    const cappedAlwaysQuick = alwaysThinking && (
      (reasoningPolicy.providerType === 'kimi' && /^kimi-k3(?:[.-]|$)/.test(modelName))
      || (reasoningPolicy.providerType === 'glm' && /^glm-5\.3-flash(?:[.-]|$)/.test(modelName))
    )
    await callOnce(
      effectiveConfig,
      [{ role: 'system', content: 'ping' }, { role: 'user', content: 'ping' }],
      undefined,
      {
        maxTokens: alwaysThinking && !cappedAlwaysQuick ? 512 : 8,
        strictLength: false,
        allowEmptyContent: true,
        extraBody: providerExtraBody(effectiveConfig, false),
        allowReasoning: alwaysThinking,
        acceptReasoningResponse: true,
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
