/**
 * 单机 LLM TTS 与全局音频系统之间的共享总线。
 * useAudio 注册唯一播放器；单机 runtime 只发布音频，不依赖 App.vue 或联机层。
 */
export type LlmAudioPlayer = (url: string, seat: number, messageId: number) => void

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

export function hasLlmAudioPlayer(): boolean {
  return player !== null
}

export function resetLlmAudioBusForTests(): void {
  player = null
}
