import {
  cancelLocalLlmAudioPlayback,
  canPlayLocalLlmAudio,
  playLocalLlmAudioUntilMidpoint,
  type LlmAudioPlaybackHooks,
} from '../core/presentation/llmAudioBus'
import { inferLlmProviderType, type LlmProviderPreset, type LlmStyle, type LlmTtsVoiceKey } from './config'
import type { LlmSpeechPriority } from './speechPolicy'
import { avatarFolderOf } from './persona'

/**
 * 自有 TTS 网关（持有供应商 key，前端不能直连供应商）。
 * 平台域名已从 `*.lumigrav.space` 迁到 `gamesvibe.app`（2026-09-14 用户决定**彻底弃用旧域名**），
 * 这里原来只认旧域名，导致线上同源请求 `/api/local-tts/synthesize` 返回 404、
 * LLM/llmAnime 主题**静默没有语音**。现在只认新域名，并保留运行期回退探针
 * （见 LocalTtsClient.synthesize）：以后再换域名也不会静默失效。
 */
const LOCAL_TTS_GATEWAY = 'https://www.bestguo.top:58000'
/** 平台域名（vibehub 发布域，页面本身没有后端，必须走网关）。旧域名 lumigrav.space 已弃用。 */
const PLATFORM_TTS_HOSTS = ['gamesvibe.app']
const AUDIO_PATH_RE = /^\/api\/local-tts\/audio\/[0-9a-f]{64}\.mp3$/
const REQUEST_TIMEOUT_MS = 8_000

interface LocalTtsResponse {
  cacheKey: string
  audioUrl: string
  cached: boolean
}

type FetchLike = typeof fetch

function trimBase(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function isPlatformTtsHost(hostname: string): boolean {
  return PLATFORM_TTS_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`))
}

export function resolveLocalTtsBaseUrl(): string {
  const configured = import.meta.env.VITE_LOCAL_TTS_BASE_URL || import.meta.env.VITE_API_BASE
  if (configured) return trimBase(configured)
  if (typeof location !== 'undefined'
    && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    // 本地统一走同源 /api proxy，避免 localhost → 127.0.0.1 跨源/PNA 拦截。
    return ''
  }
  if (typeof location !== 'undefined' && isPlatformTtsHost(location.hostname)) {
    return LOCAL_TTS_GATEWAY
  }
  // master 生产同源；本地开发由 Vite /api proxy 转发。
  return ''
}

export function resolveLocalTtsVoiceKey(preset: LlmProviderPreset): Exclude<LlmTtsVoiceKey, 'auto'> {
  if (preset.ttsVoiceKey && preset.ttsVoiceKey !== 'auto') return preset.ttsVoiceKey
  const inferred = inferLlmProviderType(preset.baseUrl, preset.model)
  const providerType = preset.providerType && preset.providerType !== 'custom'
    ? preset.providerType
    : inferred
  if (providerType === 'openai') return 'gpt'
  if (providerType !== 'custom') return providerType
  const folder = avatarFolderOf(preset)
  if (folder === 'gpt') return 'gpt'
  if (['deepseek', 'qwen', 'kimi', 'doubao', 'minimax', 'glm', 'claude'].includes(folder)) {
    return folder as Exclude<LlmTtsVoiceKey, 'auto' | 'default' | 'gpt' | 'relay_gpt'>
  }
  return 'default'
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 30)
}

function estimateMidpointMs(text: string): number {
  // 中文 TTS 通常约 4～5 字/秒；只在媒体 duration 尚不可用时兜底。
  return Math.min(2_500, Math.max(600, [...text].length * 120))
}

export class LocalTtsClient {
  private readonly inflight = new Map<string, Promise<string | null>>()
  private readonly negativeUntil = new Map<string, number>()
  private readonly activeControllers = new Set<AbortController>()
  private readonly fetchImpl: FetchLike
  private messageId = 0
  /** 同源基址失败后已探到的可用网关（运行期记忆，避免每次请求都白跑一次 404）。 */
  private resolvedBaseUrl: string | null = null

  constructor(
    private readonly baseUrl = resolveLocalTtsBaseUrl(),
    fetchImpl: FetchLike = fetch,
  ) {
    // Window.fetch 是带宿主品牌检查的原生方法；作为类字段调用会把 this 错绑为
    // LocalTtsClient，Chromium 抛 Illegal invocation。显式绑定 globalThis。
    this.fetchImpl = fetchImpl.bind(globalThis)
  }

  /** 请求基址候选：同源基址为空时额外挂一个网关探针（页面所在平台没有后端时的兜底）。 */
  private baseCandidates(): string[] {
    if (this.resolvedBaseUrl !== null) return [this.resolvedBaseUrl]
    if (this.baseUrl) return [this.baseUrl]
    return [this.baseUrl, LOCAL_TTS_GATEWAY]
  }

  async speak(
    seat: number,
    text: string,
    voiceKey: string,
    style: LlmStyle,
    priority: LlmSpeechPriority = 'normal',
    hooks: LlmAudioPlaybackHooks = {},
  ): Promise<boolean> {
    const normalized = normalizeText(text)
    if (!normalized || hooks.signal?.aborted) return false
    // 静音时不请求 TTS 网关；runtime 会立即显示气泡并继续动作。
    if (!canPlayLocalLlmAudio()) return false
    const key = JSON.stringify([normalized, voiceKey, style, hooks.cacheIdentity ?? ''])
    if ((this.negativeUntil.get(key) ?? 0) > Date.now()) return false
    let request = this.inflight.get(key)
    if (!request) {
      request = this.synthesize(normalized, voiceKey, style, hooks.cacheIdentity, hooks.signal)
      this.inflight.set(key, request)
    }
    let url: string | null
    try {
      url = await request
    } finally {
      if (this.inflight.get(key) === request) this.inflight.delete(key)
    }
    if (hooks.signal?.aborted || hooks.isCurrent?.() === false) return false
    if (!url) {
      this.negativeUntil.set(key, Date.now() + 30_000)
      return false
    }
    if (hooks.signal?.aborted || hooks.isCurrent?.() === false) return false
    this.messageId += 1
    return playLocalLlmAudioUntilMidpoint(url, seat, this.messageId, priority, {
      ...hooks,
      fallbackMidpointMs: hooks.fallbackMidpointMs ?? estimateMidpointMs(normalized),
    })
  }

  cancel(): void {
    this.activeControllers.forEach((controller) => controller.abort())
    this.activeControllers.clear()
    cancelLocalLlmAudioPlayback()
  }

  /**
   * 只合成不播放：一炮多响等并发场景预先解析音频地址，到点后用组播通道同时播放。
   * 复用与 speak 相同的归一化、缓存键与负缓存语义。
   */
  async resolveAudioUrl(
    text: string,
    voiceKey: string,
    style: LlmStyle,
    cacheIdentity?: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const normalized = normalizeText(text)
    if (!normalized || signal?.aborted) return null
    if (!canPlayLocalLlmAudio()) return null
    const key = JSON.stringify([normalized, voiceKey, style, cacheIdentity ?? ''])
    if ((this.negativeUntil.get(key) ?? 0) > Date.now()) return null
    let request = this.inflight.get(key)
    if (!request) {
      request = this.synthesize(normalized, voiceKey, style, cacheIdentity, signal)
      this.inflight.set(key, request)
    }
    try {
      const url = await request
      if (!url) this.negativeUntil.set(key, Date.now() + 30_000)
      return url
    } finally {
      if (this.inflight.get(key) === request) this.inflight.delete(key)
    }
  }

  private async synthesize(
    text: string,
    voiceKey: string,
    style: LlmStyle,
    cacheIdentity = '',
    signal?: AbortSignal,
  ): Promise<string | null> {
    for (const base of this.baseCandidates()) {
      const attempt = await this.synthesizeAt(base, text, voiceKey, style, cacheIdentity, signal)
      if (attempt.url) {
        // 探针成功的基址记下来：后续请求不再先撞一次死基址（例如平台换域名后的同源 404）。
        if (base !== this.baseUrl) this.resolvedBaseUrl = base
        return attempt.url
      }
      // 只有"没打通"（网络/状态码）才换下一个基址；打通了但响应不合契约说明网关本身有问题，换也没用。
      if (!attempt.retryable || signal?.aborted) return null
    }
    return null
  }

  private async synthesizeAt(
    base: string,
    text: string,
    voiceKey: string,
    style: LlmStyle,
    cacheIdentity: string,
    signal?: AbortSignal,
  ): Promise<{ url: string | null; retryable: boolean }> {
    const controller = new AbortController()
    this.activeControllers.add(controller)
    const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    try {
      const response = await this.fetchImpl(`${base}/api/local-tts/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceKey, style, cacheIdentity }),
        signal: controller.signal,
      })
      if (!response.ok) {
        if (import.meta.env.DEV) console.warn(`[LocalTTS] synthesize HTTP ${response.status}${base ? ` @ ${base}` : ''}`)
        return { url: null, retryable: true }
      }
      const payload = await response.json() as Partial<LocalTtsResponse>
      if (typeof payload.audioUrl !== 'string' || !AUDIO_PATH_RE.test(payload.audioUrl)) {
        return { url: null, retryable: false }
      }
      return { url: base ? `${base}${payload.audioUrl}` : payload.audioUrl, retryable: false }
    } catch (error) {
      if (import.meta.env.DEV) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'
        console.warn(`[LocalTTS] synthesize failed${base ? ` @ ${base}` : ''}: ${reason}`)
      }
      return { url: null, retryable: true }
    } finally {
      this.activeControllers.delete(controller)
      signal?.removeEventListener('abort', abort)
      globalThis.clearTimeout(timeout)
    }
  }
}

let client: LocalTtsClient | null = null

export function getLocalTtsClient(): LocalTtsClient {
  client ??= new LocalTtsClient()
  return client
}

export function resetLocalTtsClientForTests(): void {
  client = null
}
