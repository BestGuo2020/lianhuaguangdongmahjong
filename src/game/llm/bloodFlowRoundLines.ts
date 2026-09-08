// 血流专属局末台词（2026-09-08 用户要求）：输家只自我评价、不评价别人；
// 赢家与荒庄沿用共享 winLines 台词库，不修改非血流玩法。
import type { LlmStyle } from './config'
import { llmRoundReactionLine, type LlmRoundReaction } from './winLines'

export const BLOOD_FLOW_LOSS_LINES: Record<LlmStyle, readonly string[]> = {
  激进: ['这局是我没跟上，下局打回来！', '输得不冤，我回去就复盘！', '状态没打出来，下局调整到位！'],
  稳健: ['这局是我算漏了，回去复盘。', '判断有偏差，下局再稳一点。', '这几手打得保守了，下次调整。'],
  话痨: ['哎呀这局我没接住，下局继续！', '输了输了，容我复盘一下再战！', '我这把牌打得有点飘，下局来过！'],
  高冷: ['这局我输了，仅此而已。', '我自己的问题，下一局。', '一局而已，继续。'],
}

/** 血流局末台词：输家走血流专属自我评价台词；赢家与荒庄沿用共享台词库。 */
export function bloodFlowRoundReactionLine(
  reaction: LlmRoundReaction,
  style: LlmStyle,
  sequence = 0,
): string {
  if (reaction.outcome === 'loss') {
    const variants = BLOOD_FLOW_LOSS_LINES[style]
    return variants[Math.abs(sequence) % variants.length]
  }
  return llmRoundReactionLine(reaction, style, sequence)
}
