import type { LlmStyle } from './config'

export type LlmWinType = 'self-draw' | 'discard-win' | 'robbed-kong-win'
export type LlmRoundReaction =
  | { outcome: 'win'; type: LlmWinType }
  | { outcome: 'loss' }
  | { outcome: 'draw' }

export const LLM_WIN_LINES: Record<LlmWinType, Record<LlmStyle, readonly string[]>> = {
  'self-draw': {
    激进: ['自摸，这桌归我管！', '牌到手了，全都坐好！', '自摸拿下，谁还不服！'],
    稳健: ['自摸，水到渠成。', '牌路算准了，承让。', '自摸到手，不急不躁。'],
    话痨: ['自摸啦，终于等到你！', '好家伙，这都能自摸！', '这一摸，快乐来得突然！'],
    高冷: ['自摸，意料之中。', '牌到了，仅此而已。', '自摸，刚刚好。'],
  },
  'discard-win': {
    激进: ['放枪，就等你这张！', '送上门了，我可不客气！', '敢打这张，那我胡了！'],
    稳健: ['放枪，这张正合适。', '等到了，多谢配合。', '牌送得巧，承让。'],
    话痨: ['放枪啦，你真懂我！', '这张来得也太及时了！', '缘分到了，挡都挡不住！'],
    高冷: ['放枪，这张我收了。', '牌不错，归我了。', '正合我意，放枪。'],
  },
  'robbed-kong-win': {
    激进: ['抢杠胡，这杠你开不了！', '想补杠，先问过我！', '这张敢杠，我就敢胡！'],
    稳健: ['抢杠胡，时机正好。', '这步杠牌，我算到了。', '杠得很巧，正中下怀。'],
    话痨: ['抢杠胡啦，惊不惊喜！', '这杠一亮，我可精神了！', '等的就是你这一杠！'],
    高冷: ['抢杠胡，别挣扎。', '这杠，不成立。', '时机到了，抢杠胡。'],
  },
}

export const LLM_LOSS_LINES: Record<LlmStyle, readonly string[]> = {
  激进: ['这局算你们走运，下局再来！', '输一局而已，我马上打回来！', '先让一局，下一把见真章！'],
  稳健: ['这局承让，我再复盘一下。', '胜负常事，下一局稳住。', '这局判断有偏差，下局调整。'],
  话痨: ['哎呀这局没接住，下局继续！', '输了输了，容我喝口水再战！', '这把牌有自己的想法，下局来过！'],
  高冷: ['这局输了，仅此而已。', '结果已定，下一局。', '一局而已，继续。'],
}

export const LLM_DRAW_LINES: Record<LlmStyle, readonly string[]> = {
  激进: ['荒庄？下一局别再躲了！', '没人拿下，那就下局决胜！', '这局没分胜负，继续来！'],
  稳健: ['荒庄收场，下一局再寻机会。', '这局无人和牌，重新来过。', '牌局未定，下一局继续。'],
  话痨: ['荒庄啦，大家都藏得挺深！', '谁也没胡成，这局真能憋！', '好嘛，全员陪跑，下一局继续！'],
  高冷: ['荒庄，下一局。', '无人和牌，继续。', '未分胜负，仅此而已。'],
}

export function llmWinLine(type: LlmWinType, style: LlmStyle, sequence = 0): string {
  const variants = LLM_WIN_LINES[type][style]
  return variants[Math.abs(sequence) % variants.length]
}

export function llmRoundReactionLine(
  reaction: LlmRoundReaction,
  style: LlmStyle,
  sequence = 0,
): string {
  if (reaction.outcome === 'win') return llmWinLine(reaction.type, style, sequence)
  const variants = reaction.outcome === 'loss' ? LLM_LOSS_LINES[style] : LLM_DRAW_LINES[style]
  return variants[Math.abs(sequence) % variants.length]
}
