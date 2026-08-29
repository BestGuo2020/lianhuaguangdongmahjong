import { llmRoundReactionLine, type LlmRoundReaction, type LlmWinType } from '../../llm/winLines'

export type LocalLlmVoiceStyle = '激进' | '稳健' | '话痨' | '高冷'
export type LocalLlmWinType = LlmWinType

interface LocalLlmSeatVoice {
  style: LocalLlmVoiceStyle
  announce(text: string): void | Promise<void>
  generateReaction?(
    reaction: LlmRoundReaction,
    fallback: string,
    variationIndex: number,
  ): Promise<string | null>
  reactionSequence: number
}

const seats = new Map<number, LocalLlmSeatVoice>()

export function clearLocalLlmVoiceSeats(): void {
  seats.clear()
}

export function registerLocalLlmVoiceSeat(
  seat: number,
  style: LocalLlmVoiceStyle,
  announce: (text: string) => void | Promise<void>,
  generateReaction?: LocalLlmSeatVoice['generateReaction'],
): void {
  seats.set(seat, { style, announce, generateReaction, reactionSequence: 0 })
}

export function isLocalLlmSeat(seat: number): boolean {
  return seats.has(seat)
}

export interface LocalLlmRoundResult {
  winnerIndex: number | null
  winType?: LocalLlmWinType
  draw?: boolean
}

/**
 * 单机赛后感言队列：赢家（若为 LLM）先说，其余 LLM 按赢家起点顺时针依次说；
 * 荒庄按座位顺序。注册表中没有真人座位，因此真人永远不会进入队列。
 */
export function announceLocalLlmRoundReactions(result: LocalLlmRoundResult): Promise<void> | undefined {
  const registered = [...seats.keys()].sort((a, b) => a - b)
  if (!registered.length) return undefined
  const winner = result.draw ? null : result.winnerIndex
  const order = winner != null && registered.includes(winner)
    ? [winner, ...registered.filter((seat) => seat !== winner)
      .sort((a, b) => ((a - winner + 4) % 4) - ((b - winner + 4) % 4))]
    : registered

  return (async () => {
    const plans = order.flatMap((seat, queueIndex) => {
      const voice = seats.get(seat)
      if (!voice) return []
      const reaction: LlmRoundReaction = result.draw
        ? { outcome: 'draw' }
        : seat === winner
          ? { outcome: 'win', type: result.winType ?? 'self-draw' }
          : { outcome: 'loss' }
      // 每个 AI 的 reactionSequence 负责跨局轮换，queueIndex 负责同局错开；
      // 同性格的多个输家不会再因为各自序号同步而说出同一句。
      const variationIndex = voice.reactionSequence + queueIndex
      const fallback = llmRoundReactionLine(reaction, voice.style, variationIndex)
      voice.reactionSequence += 1
      return [{ voice, reaction, fallback, variationIndex }]
    })
    // 模型文本并行生成，避免三个座位逐个等待网络；播报仍在下面严格串行。
    const generated = await Promise.all(plans.map(async (plan) => (
      plan.voice.generateReaction
        ? plan.voice.generateReaction(plan.reaction, plan.fallback, plan.variationIndex).catch(() => null)
        : null
    )))
    const used = new Set<string>()
    for (const [index, plan] of plans.entries()) {
      let text = generated[index] || plan.fallback
      if (used.has(text)) text = plan.fallback
      used.add(text)
      await plan.voice.announce(text)
    }
  })()
}

export function resetLocalLlmVoiceRegistryForTests(): void {
  seats.clear()
}
