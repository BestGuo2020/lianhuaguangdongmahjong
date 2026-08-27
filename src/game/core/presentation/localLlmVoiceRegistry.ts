import { llmWinLine, type LlmWinType } from '../../llm/winLines'

export type LocalLlmVoiceStyle = '激进' | '稳健' | '话痨' | '高冷'
export type LocalLlmWinType = LlmWinType

interface LocalLlmSeatVoice {
  style: LocalLlmVoiceStyle
  announce(text: string): void
  winSequence: number
}

const seats = new Map<number, LocalLlmSeatVoice>()

export function clearLocalLlmVoiceSeats(): void {
  seats.clear()
}

export function registerLocalLlmVoiceSeat(
  seat: number,
  style: LocalLlmVoiceStyle,
  announce: (text: string) => void,
): void {
  seats.set(seat, { style, announce, winSequence: 0 })
}

export function isLocalLlmSeat(seat: number): boolean {
  return seats.has(seat)
}

/** 返回 true 表示该赢家是单机 LLM，调用方应屏蔽原始胡牌人声。 */
export function announceLocalLlmWin(seat: number, type: LocalLlmWinType): boolean {
  const voice = seats.get(seat)
  if (!voice) return false
  voice.announce(llmWinLine(type, voice.style, voice.winSequence))
  voice.winSequence += 1
  return true
}

export function resetLocalLlmVoiceRegistryForTests(): void {
  seats.clear()
}
