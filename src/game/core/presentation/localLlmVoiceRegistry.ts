import { llmWinLine, type LlmWinType } from '../../llm/winLines'

export type LocalLlmVoiceStyle = '激进' | '稳健' | '话痨' | '高冷'
export type LocalLlmWinType = LlmWinType

interface LocalLlmSeatVoice {
  style: LocalLlmVoiceStyle
  announce(text: string): void
  winSequence: number
}

const seats = new Map<number, LocalLlmSeatVoice>()

const WIN_LINES: Record<LocalLlmWinType, Record<LocalLlmVoiceStyle, string>> = {
  'self-draw': {
    激进: '自摸！这局我收下了！', 稳健: '自摸，稳稳收下。',
    话痨: '自摸啦！这手终于等到了！', 高冷: '自摸。',
  },
  'discard-win': {
    激进: '放枪！这张我等很久了！', 稳健: '放枪，多谢送牌。',
    话痨: '放枪啦！这张正好送到手上！', 高冷: '放枪。',
  },
  'robbed-kong-win': {
    激进: '抢杠胡！这杠开不得！', 稳健: '抢杠胡，时机刚好。',
    话痨: '抢杠胡啦！这张我可等着呢！', 高冷: '抢杠胡。',
  },
}

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
