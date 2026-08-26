/**
 * 单机 LLM TTS 与全局音频系统之间的共享总线。
 * useAudio 注册唯一播放器；单机 runtime 只发布音频，不依赖 App.vue 或联机层。
 */
import type { LlmSpeechPriority } from '../../llm/speechPolicy'

export interface LlmAudioPlaybackHooks {
  /** HTMLAudio 真正进入 playing 状态时触发；本地气泡据此与声音同步出现。 */
  onStarted?: () => void
  /** duration 暂不可用时的动作放行兜底（从 playing 开始计时）。 */
  fallbackMidpointMs?: number
}

export type LlmAudioPlayer = (
  url: string,
  seat: number,
  messageId: number,
  priority?: LlmSpeechPriority,
  hooks?: LlmAudioPlaybackHooks,
) => void | boolean | Promise<void | boolean>

const LOCAL_LLM_AUDIO_EVENT = 'lianhua:local-llm-audio'
const LOCAL_AUDIO_PATH_RE = /^\/api\/local-tts\/audio\/[0-9a-f]{64}\.mp3$/

interface LocalLlmAudioDetail {
  url: string
  seat: number
  messageId: number
  priority: LlmSpeechPriority
}

let player: LlmAudioPlayer | null = null
let playerEnabled: (() => boolean) | null = null
let cancelPlayback: (() => void) | null = null

export function registerLlmAudioPlayer(
  next: LlmAudioPlayer,
  isEnabled: () => boolean = () => true,
  cancel: () => void = () => {},
): () => void {
  player = next
  playerEnabled = isEnabled
  cancelPlayback = cancel
  return () => {
    if (player === next) {
      player = null
      playerEnabled = null
      cancelPlayback = null
    }
  }
}

/** 静音/音效关闭时让 TTS 客户端在网络合成前快速退出。 */
export function canPlayLocalLlmAudio(): boolean {
  return Boolean(player && playerEnabled?.())
}

export function cancelLocalLlmAudioPlayback(): void {
  cancelPlayback?.()
}

/**
 * 单机动作时间线专用：等待播放器真正开始，并在播放中点返回。
 * 返回 false 表示静音、未注册、播放失败或被取消，调用方应显示气泡并立即放行动作。
 */
export async function playLocalLlmAudioUntilMidpoint(
  url: string,
  seat: number,
  messageId: number,
  priority: LlmSpeechPriority = 'normal',
  hooks: LlmAudioPlaybackHooks = {},
): Promise<boolean> {
  const activePlayer = player
  if (!activePlayer || !playerEnabled?.()) return false
  try {
    return await activePlayer(url, seat, messageId, priority, hooks) !== false
  } catch {
    return false
  }
}

export function enqueueLlmAudio(
  url: string,
  seat: number,
  messageId: number,
  priority: LlmSpeechPriority = 'normal',
): boolean {
  if (!player) return false
  player(url, seat, messageId, priority)
  return true
}

/**
 * 浏览器级事件不依赖 ESM 单例状态，Vite HMR 或双分支装配重建模块后仍能送达。
 * Node/SSR 测试环境回退到进程内播放器。
 */
export function dispatchLocalLlmAudio(
  url: string,
  seat: number,
  messageId: number,
  priority: LlmSpeechPriority = 'normal',
): boolean {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') {
    return enqueueLlmAudio(url, seat, messageId, priority)
  }
  window.dispatchEvent(new CustomEvent<LocalLlmAudioDetail>(LOCAL_LLM_AUDIO_EVENT, {
    detail: { url, seat, messageId, priority },
  }))
  return true
}

export function subscribeLocalLlmAudio(next: LlmAudioPlayer): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Partial<LocalLlmAudioDetail>>).detail
    if (!detail || typeof detail.url !== 'string'
      || !Number.isInteger(detail.seat) || detail.seat! < 0 || detail.seat! > 3
      || !Number.isInteger(detail.messageId) || detail.messageId! < 1
      || (detail.priority !== 'normal' && detail.priority !== 'important')) return
    try {
      const parsed = new URL(detail.url, window.location.href)
      if (!['http:', 'https:'].includes(parsed.protocol) || !LOCAL_AUDIO_PATH_RE.test(parsed.pathname)) return
    } catch {
      return
    }
    next(detail.url, detail.seat!, detail.messageId!, detail.priority)
  }
  window.addEventListener(LOCAL_LLM_AUDIO_EVENT, listener)
  return () => window.removeEventListener(LOCAL_LLM_AUDIO_EVENT, listener)
}

export function resetLlmAudioBusForTests(): void {
  player = null
  playerEnabled = null
  cancelPlayback = null
}
