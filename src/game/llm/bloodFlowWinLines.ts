// 血流「胡牌瞬间」专属台词库（2026-09-19 建，同日按用户评审返工）。
//
// 起因（用户反馈）：血流一局会胡很多次，但胡牌那一刻只有动作字「胡 / 自摸」和一句
// 固定台词——`decisionSpeech` 的 win 行每性格只有一句，且锁手座位与单候选窗口根本不
// 请求模型，于是整局反复播同一句，十分单调。
//
// 本库专管**局内即时**语气，与既有两个库分工明确、互不替代：
// - `winLines.ts`：经典玩法（一局一胡）的局末感言；
// - `bloodFlowRoundLines.ts`：血流**本局结束**的感言（「收官 / 净胜」语境）；
// - 本库：血流**每一次胡牌当场**的短句（不提「收官」「本局结束」）。
//
// 档位规则（2026-09-19 评审后定稿）：
//   大牌 > 连胡 > 胡法基础档
// **大牌**：主番权重 ≥8（与牌桌光束 / 字效同源）**或**最终倍数 ≥8（玩家真正感知的「赢得多」），
// 取或，避免「权重 4 + 硬胡 + 自摸 = 16 倍」这种大牌听不到大牌台词。
// **连胡**：本局第 3 胡起、与自己的上一胡同源、**且全场上一胡也是自己**。早期实现按胡牌序号直接
// 进连胡档，结果从第 3 胡起自摸 / 点炮 / 抢杠又听不出区别（一个座位一局能胡十几次，等于把用户最初
// 要的「胡法区分」重新抹平）；只比「自己上一胡同源」时，中间别人胡过也会说「连着来」（名不副实）；
// 两个限制都补上后，胡法交替时始终说各自胡法的台词，连胡语气只在真的连着时出现。
// **一炮多响不设专属台词**（2026-09-19 用户决定）：多响批次里每个赢家各说自己的胡法 / 连胡台词，
// 不再有「一炮多响」这一类语气；牌桌上的「一炮多响」字效（`multiWinIntroMs`）与该决定无关，保留。
//
// 约束（与血流出品口径一致）：第一人称、不指代或评价他人、≤16 字、不含幕后词与暗手结构词；
// 不使用「仅此而已」等已被局末库用滥的收尾套语，不写具体家数（一炮三响真实存在），
// 句首语气词按性格打散（见 `bloodFlowWinLines.test.ts`）。
import type { LlmStyle } from './config'
import type { WinSource } from '../variants/lotus/bloodFlow/types'

/** 基础档按胡法分四组；高光档按局势分两组（优先级见 `bloodFlowWinMomentGroup`）。 */
export type BloodFlowWinMomentGroup =
  | 'self-draw'
  | 'discard-win'
  | 'robbed-kong-win'
  | 'kong-bloom-win'
  | 'streak'
  | 'big'

export const BLOOD_FLOW_MOMENT_LINES: Record<BloodFlowWinMomentGroup, Record<LlmStyle, readonly string[]>> = {
  'self-draw': {
    激进: ['自己摸上来的，收！', '这手自摸，正中我意！', '摸到了，接着打！'],
    稳健: ['摸得刚好，节奏没乱。', '牌自己来了，稳稳收下。', '这一摸，早就算到了。'],
    话痨: ['诶，自己摸上来啦！', '哈哈，这一摸真舒服！', '手气回来了，自摸！'],
    高冷: ['自摸，不必多言。', '牌到了，归我。', '这一摸，够了。'],
  },
  'discard-win': {
    激进: ['等这张很久了，胡！', '放出来的牌，我收！', '这张来得正好，胡！'],
    稳健: ['等到了，就等这张。', '这一张，等得值。', '放出的牌，算准了。'],
    话痨: ['哈哈，这张来得妙！', '等到了，终于接上！', '诶，这张我接住了！'],
    高冷: ['胡了，收下。', '来得正好。', '这张，归我。'],
  },
  'robbed-kong-win': {
    激进: ['这杠我抢了，胡！', '敢开杠，我就抢！', '杠开得正好，我收！'],
    稳健: ['抢杠，算准了的。', '这杠露了口，我胡。', '这一抢，早备好了。'],
    话痨: ['抢杠啦，这下热闹！', '诶，这一杠我等好久！', '哈哈，杠上被我截胡！'],
    高冷: ['抢杠，成了。', '这一杠，我抢了。', '杠开得不是时候。'],
  },
  'kong-bloom-win': {
    激进: ['杠上开花，我来了！', '开杠又自摸，双喜！', '杠完就摸到，痛快！'],
    稳健: ['开杠换来的，收下。', '这一杠，摸得准。', '开杠就有回报。'],
    话痨: ['杠上开花，赚到啦！', '诶，开杠还能自摸！', '这杠开得太值了！'],
    高冷: ['杠上开花，收了。', '杠后自摸，正好。', '开杠还能摸到。'],
  },
  streak: {
    激进: ['又一个，接着来！', '连胡不停，稳住！', '这局我还没打完！'],
    稳健: ['又一手，手感还在。', '连着来，一步不乱。', '这条路，走顺了。'],
    话痨: ['诶，又来一个！', '连着胡，太爽了吧！', '这一局我要打满啦！'],
    高冷: ['又一手，收下。', '再一手。', '还是我。'],
  },
  big: {
    激进: ['这牌够大，收下！', '大牌到手，别眨眼！', '大牌就该这么打！'],
    稳健: ['番数到位，落袋。', '这一手，做成了。', '牌面凑齐了，收下。'],
    话痨: ['哇，这牌好大！', '咦，这把够重！', '做成了做成了，好大！'],
    高冷: ['这牌，够重。', '分量到了，收。', '这手够重，收。'],
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

/**
 * 「大牌」档判据：主番权重 ≥8（与牌桌光束 / 字效同源）**或**最终倍数 ≥8（玩家真正感知的「赢得多」）。
 * 取或是 2026-09-19 评审结论：只看权重时，`权重 4 + 硬胡 + 自摸 = 16 倍` 这种大牌听不到大牌台词，
 * 演出与台词在「大」的判断上不同步；只看倍数则小番硬胡也能喊大牌，与光束强度打架。
 */
export function bloodFlowWinMomentIsBig(score: {
  readonly items: readonly { readonly weight: number }[]
  readonly finalMultiplier?: number
}): boolean {
  return bloodFlowWinMomentTier(score) >= 2 || (score.finalMultiplier ?? 0) >= 8
}

export interface BloodFlowWinMomentContext {
  /** `PublicWinScore.source`：本次胡牌的真实来源。 */
  source: WinSource
  style: LlmStyle
  /** 本局该座位的第几次胡（`WinRecord.ordinal`，1 起）。 */
  ordinal?: number
  /** 是否大牌（`bloodFlowWinMomentIsBig`）。 */
  big?: boolean
  /** 本局该座位上一胡的来源（`previousBloodFlowWin`）；缺省视为没有上一胡。 */
  previousSource?: WinSource | null
  /** 全场上一胡是否也是本座位（`previousBloodFlowWin`）：连胡必须真的连着，中间别人胡过就不算。 */
  previousWasSelf?: boolean
  /** 轮换序号（跨局递增，调用方通常再叠加座位号，避免同批赢家说同一句）；缺省时用本局胡牌序号。 */
  sequence?: number
}

/**
 * 档位优先级：大牌 > 连胡 > 胡法基础档。
 * - 连胡有两个限制：**第 3 胡起**、**与自己的上一胡同源**、且**全场上一胡也是自己**。
 *   早期实现按胡牌序号直接进连胡档，血流一个座位一局能胡十几次，第 3 胡后自摸 / 点炮又听不出
 *   区别（2026-09-19 评审一）；只比「自己上一胡同源」时，中间别人胡过也会说「连着来」
 *   （2026-09-19 评审二：名不副实），故补上「全场上一胡也是自己」。
 * - 一炮多响不单列档位：同批各赢家按各自的胡法 / 连胡状态取词（用户 2026-09-19 决定）。
 */
export function bloodFlowWinMomentGroup(context: BloodFlowWinMomentContext): BloodFlowWinMomentGroup {
  if (context.big) return 'big'
  if ((context.ordinal ?? 1) >= 3 && context.previousWasSelf === true
    && context.previousSource != null && context.previousSource === context.source) return 'streak'
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
