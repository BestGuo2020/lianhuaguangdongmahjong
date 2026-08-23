import type { LlmStyle } from './config'

export type LlmWinType = 'self-draw' | 'discard-win' | 'robbed-kong-win'

export const LLM_WIN_LINES: Record<LlmWinType, Record<LlmStyle, readonly string[]>> = {
  'self-draw': {
    激进: ['自摸，这桌归我管！', '牌到手了，全都坐好！', '自摸拿下，谁还不服！'],
    稳健: ['自摸，水到渠成。', '牌路算准了，承让。', '稳稳自摸，不急不躁。'],
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

export function llmWinLine(type: LlmWinType, style: LlmStyle, sequence = 0): string {
  const variants = LLM_WIN_LINES[type][style]
  return variants[Math.abs(sequence) % variants.length]
}
