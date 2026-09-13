import type { PatternDefinition, PatternId } from '../patterns/types'
import type { BloodFlowRuleConfig } from './types'
import type { DefensePolicyConfig } from './defensePolicy'
import { BLOOD_FLOW_BIG_HAND_ROUTE, type BigHandRouteConfig } from './bigHandRoute'

function pattern(id: PatternId, label: string, weight: number, excludes: PatternId[] = []): PatternDefinition {
  return Object.freeze({ id, label, weight, excludes: Object.freeze(excludes) })
}

/**
 * 血流番值表（2026-09-12 **第二版完整番种表**，由用户定稿）。
 *
 * 梯度：1 → 2 → 4 → 6 → 8 → 12 → 16 → 24 → 32。新增了"路线牌型"：
 * 普通数牌路线（断幺九 → 三步高 → 清龙/四步高）、刻子路线（碰碰胡 → 三暗刻/三节高 → 四暗刻/四节高）、
 * 花色路线（混一色 → 清一色 → 九莲）、幺九路线（全带幺 → 混幺九 → 清幺九/字一色）、七对路线（七对 → 豪华七对）。
 * 覆盖规则用 `excludes` 表达（存在高位番种时剔除低位），详见各处注释与 catalog.ts 的判定。
 */
const patterns = Object.freeze({
  // 顶级
  'big-four-winds': pattern('big-four-winds', '大四喜', 32, ['all-triplets', 'little-four-winds']),
  // 四杠只覆盖三杠（新表 §7：杠牌系列"四杠 → 三杠"）；四杠手必然也是四刻子+将，可与碰碰胡叠加。
  'four-kongs': pattern('four-kongs', '四杠', 32, ['three-kongs']),
  'nine-gates': pattern('nine-gates', '九莲宝灯', 32, ['pure-suit']),
  // 极高番
  'big-three-dragons': pattern('big-three-dragons', '大三元', 24, ['little-three-dragons']),
  'all-honors': pattern('all-honors', '字一色', 24, ['mixed-terminals', 'all-with-terminals', 'all-triplets']),
  'pure-terminals': pattern('pure-terminals', '清幺九', 24, ['mixed-terminals', 'all-with-terminals', 'all-triplets']),
  'all-green': pattern('all-green', '绿一色', 24),
  // 大牌
  'little-three-dragons': pattern('little-three-dragons', '小三元', 16),
  'little-four-winds': pattern('little-four-winds', '小四喜', 16),
  'four-concealed-triplets': pattern('four-concealed-triplets', '四暗刻', 16, ['three-concealed-triplets', 'all-triplets', 'concealed-hand']),
  thirteenOrphans: pattern('thirteenOrphans', '十三幺', 16,
    ['all-with-terminals', 'mixed-terminals', 'sevenPairs', 'all-triplets']),
  'one-suit-four-joints': pattern('one-suit-four-joints', '一色四节高', 16, ['one-suit-three-joints', 'all-triplets']),
  // 高番
  'mixed-terminals': pattern('mixed-terminals', '混幺九', 12, ['all-with-terminals', 'all-triplets']),
  'three-kongs': pattern('three-kongs', '三杠', 12),
  'luxury-seven-pairs': pattern('luxury-seven-pairs', '豪华七对', 12,
    ['sevenPairs', 'all-triplets', 'three-concealed-triplets', 'four-concealed-triplets', 'one-suit-three-joints', 'one-suit-four-joints']),
  // 中高番
  'pure-suit': pattern('pure-suit', '清一色', 8, ['mixed-suit']),
  'one-suit-three-joints': pattern('one-suit-three-joints', '一色三节高', 8),
  'one-suit-four-steps': pattern('one-suit-four-steps', '一色四步高', 8, ['one-suit-three-steps']),
  // 中番
  'three-concealed-triplets': pattern('three-concealed-triplets', '三暗刻', 6),
  qiXing: pattern('qiXing', '七星十三烂', 6, ['shiSanLan']),
  'pure-straight': pattern('pure-straight', '清龙', 6),
  // 中低番
  'mixed-suit': pattern('mixed-suit', '混一色', 4),
  'all-triplets': pattern('all-triplets', '碰碰胡', 4),
  sevenPairs: pattern('sevenPairs', '七对', 4,
    ['all-triplets', 'three-concealed-triplets', 'four-concealed-triplets', 'one-suit-three-joints', 'one-suit-four-joints']),
  'one-suit-three-steps': pattern('one-suit-three-steps', '一色三步高', 4),
  'all-with-terminals': pattern('all-with-terminals', '全带幺', 4),
  // 低番 / 基础
  shiSanLan: pattern('shiSanLan', '十三烂', 2),
  'all-simples': pattern('all-simples', '断幺九', 2, ['all-with-terminals', 'mixed-terminals', 'pure-terminals', 'all-honors']),
  // 门清平胡：**仅标准四面子一将型生效**（七对/十三幺/十三烂/七星等特殊结构不计，见 catalog.ts 的判定位置）
  // 覆盖方向：由高位番种排除它（四暗刻/九莲宝灯），不要反过来——否则会把大牌吃掉。
  'concealed-hand': pattern('concealed-hand', '门清平胡', 2),
  pinghu: pattern('pinghu', '鸡胡', 1),
})

/**
 * 杠加成（2026-09-12 新增，用户暂定）：每个**明杠 +1**、每个**暗杠/风杠 +2**，直接加到基础倍率上。
 * 此前杠没有任何番型加成，"胡后可开杠"也就没有收益——这是三杠/四杠这类牌型做不出来的根因之一。
 */
export const BLOOD_FLOW_KONG_BONUS: Readonly<{ exposed: number; concealed: number; wind: number }> =
  Object.freeze({ exposed: 1, concealed: 2, wind: 2 })

/**
 * 动作优先级实验开关（2026-09-12，默认 standard = 线上现状）。
 *
 * `kong-priority`：
 * ① **胡牌之后仍可开杠**——锁手座位在自摸窗口可暗杠/风杠/补杠，别人打出的牌也可大明杠（仍不可碰/吃）；
 * ② **动作优先级 杠 > 碰 > 吃 > 胡**（胡最低）——同一张牌的竞争里杠/碰/吃先结算、胡被压到最后；
 *    座位自身同时有杠/碰/吃与胡时，不再把"胡"当默认首选。
 *
 * 目的：度量"是否更容易做出大牌"（尤其现在 5 万次胡牌里 0 次的三杠/四杠，以及清一色等中高番）。
 * 只用于 A/B 度量，线上保持 standard。开关来自 `VITE_BLOOD_FLOW_EXPERIMENT=kong-priority`。
 */
export const BLOOD_FLOW_ACTION_PRIORITY: 'standard' | 'kong-priority' =
  (import.meta as { env?: Record<string, string> }).env?.VITE_BLOOD_FLOW_EXPERIMENT === 'kong-priority'
    ? 'kong-priority' : 'standard'

export const BLOOD_FLOW_CONFIG: BloodFlowRuleConfig = Object.freeze({
  id: 'lotus-blood-flow',
  version: 'lotus-blood-flow-v1',
  label: '莲花麻将·血流',
  basePoints: 10,
  initialScore: 2000,
  /** 单家封顶。2026-09-12 从 64 提到 128：番值表拉开后顶端（十三幺/大三元 32 番）会被 64 吃掉。 */
  maxMultiplierPerPayer: 128,
  hardWinMultiplier: 2,
  patterns,
  eventMultipliers: Object.freeze({ discard: 1, 'self-draw': 2, 'robbed-kong': 2, 'kong-bloom': 4 }),
  openingMinimumMultiplier: 8,
  kongPayments: Object.freeze({ discard: 1, added: 1, concealed: 2, wind: 2 }),
  kongBonus: BLOOD_FLOW_KONG_BONUS,
  rounds: Object.freeze({ east: 4, hanchan: 8 }),
  lockAfterFirstWin: true,
  multipleWinners: true,
  allowNegativeScores: true,
  alreadyWonPlayersPay: true,
  dealerMultiplier: 1,
  dealerRotation: 'every-round',
  crossWindowPassRestriction: false,
  extraPayments: Object.freeze([]) as readonly [],
})

/** 本地 / WS / P2P 三面均放行：P2P 于 2026-09-10 打开，用于线上双真人 + 机器人（普通 / 大模型）整场验收。 */
export const BLOOD_FLOW_AVAILABILITY = Object.freeze({ local: true, ws: true, p2p: true })

export const BLOOD_FLOW_TIMING = Object.freeze({
  // remoteDecisionMs 与后端 BLOOD_FLOW_TIMING.remoteDecisionMs 对齐（12s = 经典房间回合超时），
  // WS 权威与 P2P 权威共用同一决策窗口，读秒长度不再两套。
  winBeatMs: 450, normalDecisionMs: 15_000, remoteDecisionMs: 12_000, recoveryGraceMs: 12_000,
  compactWinMs: 2300, largeWinMs: 2600, topWinMs: 2900, multiWinIntroMs: 1500,
  fullEffectCooldownMs: 8000, visualBacklogMs: 2000,
})

/**
 * 本地 AI 贪婪 EV 策略参数（见 docs/blood-flow/design/ai-strategy.md）。
 * 只影响决策，不改变计分、封顶、锁手或胡后自动续行规则。
 */
export interface BloodFlowAiConfig {
  readonly strategy: 'ev' | 'legacy'
  /** legacy 策略的首次胡单家支付门槛（旧行为保留）。 */
  readonly minimumFirstPayment: number
  /** 自摸单次总收入（×2 × 3 家）相对点炮（×1 × 1 家）的连锁期望权重。 */
  readonly selfDrawWeight: number
  /** 首胡门槛（单家支付，取合法 10 的倍数档）：早局 / 中局 / 残局。 */
  readonly firstWinFloorEarly: number
  readonly firstWinFloorMid: number
  readonly firstWinFloorLate: number
  /** 墙余分界：≤ late 为残局，> early 为早局。 */
  readonly lateGameWallCount: number
  readonly earlyGameWallCount: number
  /** 拒胡所需的最小改造潜力（Σ weight×progress²；默认 2 ≈ 一个 4 倍级方向 0.7 接近度）。 */
  readonly potentialFloor: number
  /** 改张 EV 需 ≥ 该比例 × 立即胡 EV 才执行 / 提示。 */
  readonly reformGainRatio: number
  /** 锁手后连锁期望的展望巡数。 */
  readonly chainHorizon: number
  /** 弃牌放炮成本档位（公开 0 张 / 1 张 / ≥2 张）。 */
  readonly safetyCostNone: number
  readonly safetyCostOne: number
  readonly safetyCostSafe: number
  /** 对手牌型（大牌）风险定价：'off' = 只看公开张数的旧口径，'tier' = 档位版（见 shared/ai/opponentPatternRisk.ts）。 */
  readonly opponentPatternRisk: 'off' | 'tier'
  /** 档位倍率：1 = 平胡量级；4/16/32 ≈ 混一色 / 清一色 / 十六倍级硬胡点炮的单家赔付量级。 */
  readonly riskFactorTier1: number
  readonly riskFactorTier2: number
  readonly riskFactorTier3: number
  /** 染手（花色集中）嫌疑对手：非嫌疑花色牌的系数。 */
  readonly riskOffSuitFactor: number
  /** 兜/弃政策阈值（v3）。 */
  readonly defense: DefensePolicyConfig
  /** 真·大牌路线（v4）：只影响 LLM 候选构造，不动引擎/普通 AI。 */
  readonly bigHandRoute: BigHandRouteConfig
  /** LLM 候选注入同源 EV 特征并以其为默认推荐（模型可覆盖、要理由）；关闭则回退旧提示词。 */
  readonly llmEvFeatures: boolean
}

/** 兜/弃政策默认值（v3；规则见 defensePolicy.ts 顶部注释）。 */
export const BLOOD_FLOW_DEFENSE: Readonly<DefensePolicyConfig> = Object.freeze({
  /** 触发"兜"的最低对手威胁档（3 = 十六倍级 / 门清大牌）。 */
  foldThreatTier: 3,
  /** 我方上限认定：番型方向接近度 ≥ 该值才算"真有机会做成"。 */
  ceilingProgress: 0.35,
  /** 我方上限认定：该方向的番型倍率下限（与对手对比用）。 */
  ceilingWeightFloor: 4,
  /** 兜牌硬约束：候选层撤碰吃杠 + 只留安全档（engine 与 LLM 共用同一份候选）。 */
  mode: 'hard',
  /** 兜牌时允许的弃牌安全档容差（0 = 只留放炮成本最小档）。 */
  foldDiscardTolerance: 0,
})

export const BLOOD_FLOW_AI: BloodFlowAiConfig = Object.freeze({  strategy: 'ev',
  minimumFirstPayment: 0,
  selfDrawWeight: 6,
  firstWinFloorEarly: 40,
  firstWinFloorMid: 20,
  firstWinFloorLate: 10,
  lateGameWallCount: 15,
  earlyGameWallCount: 40,
  potentialFloor: 2,
  reformGainRatio: 1.2,
  chainHorizon: 8,
  safetyCostNone: 0.25,
  safetyCostOne: 0.1,
  safetyCostSafe: 0,
  opponentPatternRisk: 'tier',
  riskFactorTier1: 4,
  riskFactorTier2: 16,
  riskFactorTier3: 32,
  riskOffSuitFactor: 0.5,
  defense: BLOOD_FLOW_DEFENSE,
  bigHandRoute: BLOOD_FLOW_BIG_HAND_ROUTE,
  llmEvFeatures: true,
})

/**
 * **LLM 座位**使用的 AI 配置：开启"真·大牌路线"（候选层收窄）。
 *
 * 只影响 LLM 候选构造：路线成立时撤掉"胡"、吃碰杠，弃牌只剩不掉路线的牌。
 * 普通 AI 座位不走这条路径（它们的决策来自 engineWorker/backends.bot，仍用 BLOOD_FLOW_AI），
 * 所以打开这个开关**不会改变任何机器人行为**。要回退只需改成 BLOOD_FLOW_AI。
 */
export const BLOOD_FLOW_LLM_AI: BloodFlowAiConfig = Object.freeze({
  ...BLOOD_FLOW_AI,
  bigHandRoute: Object.freeze({ ...BLOOD_FLOW_BIG_HAND_ROUTE, mode: 'llm' as const }),
})

/** Shared by the local continuation and the existing DOM/3D director. */
export function bloodFlowWinTiming(tier: number) {
  if (tier >= 2) {
    const base = tier === 3 ? BLOOD_FLOW_TIMING.topWinMs : BLOOD_FLOW_TIMING.largeWinMs
    const impact = tier === 3 ? 1110 : 1000
    const readable = tier === 3 ? 1390 : 1240
    // 收付至少停留 1 秒：score → exit ≥ 1000ms，总时长相应顺延。
    const score = base - 620
    return { duration: score + 1200, phaseMarks: { intro: 0, focus: 0, impact, readable, score, exit: score + 1000 } }
  }
  const score = 1815
  return { duration: score + 1200, phaseMarks: { intro: 0, focus: 0, impact: 870, readable: 1090, score, exit: score + 1000 } }
}
