// 血流「胡牌瞬间」专属台词库（2026-09-19）。
//
// 起因（用户反馈）：血流一局会胡很多次，但胡牌那一刻只有动作字「胡 / 自摸」和一句
// 固定台词——`decisionSpeech` 的 win 行每性格只有一句，且锁手座位与单候选窗口根本不
// 请求模型，于是整局反复播同一句，十分单调。
//
// 本库专管**局内即时**语气，与既有两个库分工明确、互不替代：
// - `winLines.ts`：经典玩法（一局一胡）的局末感言；
// - `bloodFlowRoundLines.ts`：血流**本局结束**的感言（「收官 / 净胜」语境）；
// - 本库：血流**每一次胡牌当场**的短句（不提「收官」「本局结束」），按胡法区分，
//   并在大牌、连胡、一炮多响时换成更兴奋的一档。
//
// 约束（与血流出品口径一致）：第一人称、不指代或评价他人、≤16 字、不含幕后词与暗手结构词。
import type { LlmStyle } from './config'
import type { WinSource } from '../variants/lotus/bloodFlow/types'

/** 基础档按胡法分四组；高光档按局势分三组（优先级见 `bloodFlowWinMomentGroup`）。 */
export type BloodFlowWinMomentGroup =
  | 'self-draw'
  | 'discard-win'
  | 'robbed-kong-win'
  | 'kong-bloom-win'
  | 'streak'
  | 'big'
  | 'multi'

export const BLOOD_FLOW_MOMENT_LINES: Record<BloodFlowWinMomentGroup, Record<LlmStyle, readonly string[]>> = {
  'self-draw': {
    激进: ['自摸到手，接着来！', '牌自己来了，收！', '这手自摸，痛快！'],
    稳健: ['自摸，节奏没乱。', '这张摸得刚好。', '自摸到手，稳当。'],
    话痨: ['自摸啦，手气来了！', '这一摸，太值啦！', '又自己摸上来啦！'],
    高冷: ['自摸，正好。', '牌到了，收下。', '自摸，仅此而已。'],
  },
  'discard-win': {
    激进: ['放出来的这张，我收！', '等这张很久了，胡！', '这张来得正好，收！'],
    稳健: ['这张可以，我胡了。', '等到的牌，收下。', '放出这张，正好成胡。'],
    话痨: ['哈哈，这张来得好！', '刚好接上，胡啦！', '等这张等到啦！'],
    高冷: ['胡。', '这张，归我。', '正好，胡了。'],
  },
  'robbed-kong-win': {
    激进: ['这杠我抢了，胡！', '敢开杠，我就抢！', '抢杠到手，漂亮！'],
    稳健: ['抢杠，时机正好。', '这杠开得巧，我胡。', '抢杠成胡，收下。'],
    话痨: ['抢杠啦，太爽啦！', '这一杠，我抢到啦！', '抢杠胡，痛快！'],
    高冷: ['抢杠胡，收下。', '这一杠，我抢了。', '抢杠，正好。'],
  },
  'kong-bloom-win': {
    激进: ['杠上开花，我来了！', '开杠又自摸，双喜！', '杠完就自摸，痛快！'],
    稳健: ['杠后自摸，顺理成章。', '这一杠，摸得正。', '开杠得张，正好胡。'],
    话痨: ['杠上开花，太开心啦！', '开杠还能自摸，妙！', '这杠开得真值！'],
    高冷: ['杠上开花，收下。', '杠后自摸，正好。', '开杠得牌，收了。'],
  },
  streak: {
    激进: ['又一个，接着来！', '连胡不停，稳住！', '这局我还没打完！'],
    稳健: ['又一次，节奏没乱。', '连着来，保持住。', '这一手依旧稳。'],
    话痨: ['又胡啦，停不下来！', '连着来，太过瘾啦！', '这一局太热闹啦！'],
    高冷: ['又一手，继续。', '连着来，无妨。', '继续，仅此而已。'],
  },
  big: {
    激进: ['这牌够大，收下！', '大牌到手，别眨眼！', '这一把，值了！'],
    稳健: ['这牌不小，落袋。', '番数到位，收下。', '这一手做成了。'],
    话痨: ['哇，这牌好大！', '大牌来啦，值回票价！', '这手做得太漂亮啦！'],
    高冷: ['这牌，够了。', '番数到位，胡。', '够大，收了。'],
  },
  multi: {
    激进: ['一炮多响，一起收！', '这张牌，两家齐胡！', '一炮多响，热闹！'],
    稳健: ['一炮多响，各收各的。', '同一张牌，同时成胡。', '一起收下这一手。'],
    话痨: ['一炮多响，太精彩啦！', '好家伙，同时胡啦！', '这一张，全场开花！'],
    高冷: ['一炮多响，收下。', '同时胡，仅此而已。', '一起收，继续。'],
  },
}

/**
 * 主番权重档，与 `bloodFlow/presentation.ts` 的 `winTier` 同阈值（≥4 / ≥8 / ≥16）。
 * 两处必须同时改；`bloodFlowWinLines.test.ts` 用等价断言锁住。
 */
export function bloodFlowWinMomentTier(score: { readonly items: readonly { readonly weight: number }[] }): 0 | 1 | 2 | 3 {
  const weight = Math.max(...score.items.map(item => item.weight), 1)
  return weight >= 16 ? 3 : weight >= 8 ? 2 : weight >= 4 ? 1 : 0
}

export interface BloodFlowWinMomentContext {
  /** `PublicWinScore.source`：本次胡牌的真实来源。 */
  source: WinSource
  style: LlmStyle
  /** 本局该座位的第几次胡（`WinRecord.ordinal`，1 起）。 */
  ordinal?: number
  /** 主番权重档（`bloodFlowWinMomentTier`）。 */
  tier?: 0 | 1 | 2 | 3
  /** 一炮多响：同一张弃牌有 ≥2 家同时胡。 */
  multiWin?: boolean
  /** 跨局递增的轮换序号；缺省时用本局胡牌序号轮换。 */
  sequence?: number
}

/**
 * 档位优先级：一炮多响 > 大牌（主番 ≥8）> 连胡（本局第 3 胡起）> 胡法基础档。
 * 高光档只在局势确实高光时出现，避免每次都喊「大牌」而失去分量。
 */
export function bloodFlowWinMomentGroup(context: BloodFlowWinMomentContext): BloodFlowWinMomentGroup {
  if (context.multiWin) return 'multi'
  if ((context.tier ?? 0) >= 2) return 'big'
  if ((context.ordinal ?? 1) >= 3) return 'streak'
  switch (context.source) {
    case 'self-draw': return 'self-draw'
    case 'discard': return 'discard-win'
    case 'robbed-kong': return 'robbed-kong-win'
    case 'kong-bloom': return 'kong-bloom-win'
  }
}

/** 血流胡牌当场的短句：按档位选组、按序号轮换，同组内相邻两次不会重复。 */
export function bloodFlowWinMomentLine(context: BloodFlowWinMomentContext): string {
  const variants = BLOOD_FLOW_MOMENT_LINES[bloodFlowWinMomentGroup(context)][context.style]
  const rotation = Math.abs(context.sequence ?? Math.max(0, (context.ordinal ?? 1) - 1))
  return variants[rotation % variants.length]
}
