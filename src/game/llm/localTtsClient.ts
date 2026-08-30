import {
  cancelLocalLlmAudioPlayback,
  canPlayLocalLlmAudio,
  playLocalLlmAudioUntilMidpoint,
  type LlmAudioPlaybackHooks,
} from '../core/presentation/llmAudioBus'
import { inferLlmProviderType, type LlmProviderPreset, type LlmStyle, type LlmTtsVoiceKey } from './config'
import type { LlmSpeechPriority } from './speechPolicy'
import { avatarFolderOf } from './persona'

const VIBEHUB_GATEWAY_FALLBACK = 'https://www.bestguo.top:58000'
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

export function resolveLocalTtsBaseUrl(): string {
  const configured = import.meta.env.VITE_LOCAL_TTS_BASE_URL || import.meta.env.VITE_API_BASE
  if (configured) return trimBase(configured)
  if (typeof location !== 'undefined'
    && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    // 本地统一走同源 /api proxy，避免 localhost → 127.0.0.1 跨源/PNA 拦截。
    return ''
  }
  if (typeof location !== 'undefined' && location.hostname.endsWith('lumigrav.space')) {
    return VIBEHUB_GATEWAY_FALLBACK
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

  constructor(
    private readonly baseUrl = resolveLocalTtsBaseUrl(),
    fetchImpl: FetchLike = fetch,
  ) {
    // Window.fetch 是带宿主品牌检查的原生方法；作为类字段调用会把 this 错绑为
    // LocalTtsClient，Chromium 抛 Illegal invocation。显式绑定 globalThis。
    this.fetchImpl = fetchImpl.bind(globalThis)
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
    if (!normalized) return false
    // 静音时不请求 TTS 网关；runtime 会立即显示气泡并继续动作。
    if (!canPlayLocalLlmAudio()) return false
    const key = JSON.stringify([normalized, voiceKey, style, hooks.cacheIdentity ?? ''])
    if ((this.negativeUntil.get(key) ?? 0) > Date.now()) return false
    let request = this.inflight.get(key)
    if (!request) {
      request = this.synthesize(normalized, voiceKey, style, hooks.cacheIdentity)
      this.inflight.set(key, request)
    }
    let url: string | null
    try {
      url = await request
    } finally {
      if (this.inflight.get(key) === request) this.inflight.delete(key)
    }
    if (!url) {
      this.negativeUntil.set(key, Date.now() + 30_000)
      return false
    }
    if (hooks.isCurrent?.() === false) return false
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

  private async synthesize(
    text: string,
    voiceKey: string,
    style: LlmStyle,
    cacheIdentity = '',
  ): Promise<string | null> {
    const controller = new AbortController()
    this.activeControllers.add(controller)
    const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/local-tts/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceKey, style, cacheIdentity }),
        signal: controller.signal,
      })
      if (!response.ok) {
        if (import.meta.env.DEV) console.warn(`[LocalTTS] synthesize HTTP ${response.status}`)
        return null
      }
      const payload = await response.json() as Partial<LocalTtsResponse>
      if (typeof payload.audioUrl !== 'string' || !AUDIO_PATH_RE.test(payload.audioUrl)) return null
      return this.baseUrl ? `${this.baseUrl}${payload.audioUrl}` : payload.audioUrl
    } catch (error) {
      if (import.meta.env.DEV) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'
        console.warn(`[LocalTTS] synthesize failed: ${reason}`)
      }
      return null
    } finally {
      this.activeControllers.delete(controller)
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
