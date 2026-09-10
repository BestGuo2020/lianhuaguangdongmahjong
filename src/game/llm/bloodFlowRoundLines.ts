// 血流专属局末台词（2026-09-08 用户要求）：输家只自我评价、不评价别人；
// 赢家按最后一次真实胡来源用血流专属台词（连续胡 + 净胜收尾语境）；
// 荒庄沿用共享 winLines 台词库。非血流玩法零改动。
import type { LlmStyle } from './config'
import { llmRoundReactionLine, type LlmRoundReaction, type LlmWinType } from './winLines'

export const BLOOD_FLOW_LOSS_LINES: Record<LlmStyle, readonly string[]> = {
  激进: ['这局是我没跟上，下局打回来！', '输得不冤，我回去就复盘！', '状态没打出来，下局调整到位！'],
  稳健: ['这局是我算漏了，回去复盘。', '判断有偏差，下局再稳一点。', '这几手打得保守了，下次调整。'],
  话痨: ['哎呀这局我没接住，下局继续！', '输了输了，容我复盘一下再战！', '我这把牌打得有点飘，下局来过！'],
  高冷: ['这局我输了，仅此而已。', '我自己的问题，下一局。', '一局而已，继续。'],
}

export const BLOOD_FLOW_WIN_LINES: Record<LlmWinType, Record<LlmStyle, readonly string[]>> = {
  'self-draw': {
    激进: ['这局自摸收官，净胜到手！', '一路自摸打满，这局我的！', '摸到最后一刻，赢的就是我！'],
    稳健: ['自摸收尾，本局净胜落袋。', '按计划收完，稳稳拿下。', '自摸收官，结果如愿。'],
    话痨: ['自摸收官啦，这局打得真痛快！', '最后一手自摸，完美收工！', '自摸打满全场的快乐，收下啦！'],
    高冷: ['自摸收官，意料之中。', '结果与预期一致。', '自摸收尾，仅此而已。'],
  },
  'discard-win': {
    激进: ['点炮收尾，本局照样拿下！', '该胡的都胡了，这局归我！', '收官这一胡，赢面全开！'],
    稳健: ['点炮收尾，本局净胜达成。', '收官顺利，结果满意。', '该拿的分都拿到了。'],
    话痨: ['点炮收尾，这局胡得真尽兴！', '最后一胡接住啦，本局大丰收！', '收官这一胡，漂亮收场！'],
    高冷: ['点炮收尾，无悬念。', '本局结果，已在掌握。', '收官完成，仅此而已。'],
  },
  'robbed-kong-win': {
    激进: ['抢杠收官，这局赢得漂亮！', '关键一抢，本局大局已定！', '抢杠定胜负，就是我的局！'],
    稳健: ['抢杠收尾，本局净胜到手。', '关键一步走对，结果自然。', '抢杠收官，如愿以偿。'],
    话痨: ['抢杠收官啦，这局太精彩了！', '关键那一抢，直接锁定胜局！', '抢杠收尾，打得真过瘾！'],
    高冷: ['抢杠收官，无意外。', '关键一手，结果已定。', '抢杠收尾，仅此而已。'],
  },
}

/** 血流局末台词：输家/赢家走血流专属台词；荒庄沿用共享台词库。 */
export function bloodFlowRoundReactionLine(
  reaction: LlmRoundReaction,
  style: LlmStyle,
  sequence = 0,
): string {
  if (reaction.outcome === 'loss') {
    const variants = BLOOD_FLOW_LOSS_LINES[style]
    return variants[Math.abs(sequence) % variants.length]
  }
  if (reaction.outcome === 'win') {
    const variants = BLOOD_FLOW_WIN_LINES[reaction.type][style]
    return variants[Math.abs(sequence) % variants.length]
  }
  return llmRoundReactionLine(reaction, style, sequence)
}
