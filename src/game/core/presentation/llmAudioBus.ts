/**
 * 单机 LLM TTS 与全局音频系统之间的共享总线。
 * useAudio 注册唯一播放器；单机 runtime 只发布音频，不依赖 App.vue 或联机层。
 */
export type LlmAudioPlayer = (url: string, seat: number, messageId: number) => void

const LOCAL_LLM_AUDIO_EVENT = 'lianhua:local-llm-audio'
const LOCAL_AUDIO_PATH_RE = /^\/api\/local-tts\/audio\/[0-9a-f]{64}\.mp3$/

interface LocalLlmAudioDetail {
  url: string
  seat: number
  messageId: number
}

let player: LlmAudioPlayer | null = null

export function registerLlmAudioPlayer(next: LlmAudioPlayer): () => void {
  player = next
  return () => {
    if (player === next) player = null
  }
}

export function enqueueLlmAudio(url: string, seat: number, messageId: number): boolean {
  if (!player) return false
  player(url, seat, messageId)
  return true
}

/**
 * 浏览器级事件不依赖 ESM 单例状态，Vite HMR 或双分支装配重建模块后仍能送达。
 * Node/SSR 测试环境回退到进程内播放器。
 */
export function dispatchLocalLlmAudio(url: string, seat: number, messageId: number): boolean {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') {
    return enqueueLlmAudio(url, seat, messageId)
  }
  window.dispatchEvent(new CustomEvent<LocalLlmAudioDetail>(LOCAL_LLM_AUDIO_EVENT, {
    detail: { url, seat, messageId },
  }))
  return true
}

export function subscribeLocalLlmAudio(next: LlmAudioPlayer): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Partial<LocalLlmAudioDetail>>).detail
    if (!detail || typeof detail.url !== 'string'
      || !Number.isInteger(detail.seat) || detail.seat! < 0 || detail.seat! > 3
      || !Number.isInteger(detail.messageId) || detail.messageId! < 1) return
    try {
      const parsed = new URL(detail.url, window.location.href)
      if (!['http:', 'https:'].includes(parsed.protocol) || !LOCAL_AUDIO_PATH_RE.test(parsed.pathname)) return
    } catch {
      return
    }
    next(detail.url, detail.seat!, detail.messageId!)
  }
  window.addEventListener(LOCAL_LLM_AUDIO_EVENT, listener)
  return () => window.removeEventListener(LOCAL_LLM_AUDIO_EVENT, listener)
}

export function resetLlmAudioBusForTests(): void {
  player = null
}
