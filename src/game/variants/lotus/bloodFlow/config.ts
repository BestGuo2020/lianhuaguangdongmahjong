import type { PatternDefinition, PatternId } from '../patterns/types'
import type { BloodFlowRuleConfig } from './types'

function pattern(id: PatternId, label: string, weight: number, excludes: PatternId[] = []): PatternDefinition {
  return Object.freeze({ id, label, weight, excludes: Object.freeze(excludes) })
}

/** The only blood-flow weights. Old rulesets deliberately do not import this config. */
const patterns = Object.freeze({
  'pure-suit': pattern('pure-suit', '清一色', 4),
  'mixed-suit': pattern('mixed-suit', '混一色', 2),
  'all-triplets': pattern('all-triplets', '碰碰胡', 2),
  'little-three-dragons': pattern('little-three-dragons', '小三元', 4),
  'big-three-dragons': pattern('big-three-dragons', '大三元', 8),
  'little-four-winds': pattern('little-four-winds', '小四喜', 8),
  'big-four-winds': pattern('big-four-winds', '大四喜', 16, ['all-triplets']),
  'nine-gates': pattern('nine-gates', '九莲宝灯', 16, ['pure-suit']),
  'all-green': pattern('all-green', '绿一色', 16),
  'pure-terminals': pattern('pure-terminals', '清幺九', 16, ['all-triplets']),
  'mixed-terminals': pattern('mixed-terminals', '混幺九', 4, ['all-triplets']),
  'three-concealed-triplets': pattern('three-concealed-triplets', '三暗刻', 4),
  'four-concealed-triplets': pattern('four-concealed-triplets', '四暗刻', 8, ['three-concealed-triplets', 'all-triplets']),
  'all-honors': pattern('all-honors', '字一色', 8),
  'three-kongs': pattern('three-kongs', '三杠', 8),
  'four-kongs': pattern('four-kongs', '四杠', 16, ['three-kongs', 'all-triplets']),
  pinghu: pattern('pinghu', '平胡', 1),
  sevenPairs: pattern('sevenPairs', '七对', 2),
  shiSanLan: pattern('shiSanLan', '十三烂', 2),
  qiXing: pattern('qiXing', '七星十三烂', 4),
  thirteenOrphans: pattern('thirteenOrphans', '十三幺', 16),
})

export const BLOOD_FLOW_CONFIG: BloodFlowRuleConfig = Object.freeze({
  id: 'lotus-blood-flow',
  version: 'lotus-blood-flow-v1',
  label: '莲花麻将·血流',
  basePoints: 10,
  initialScore: 2000,
  maxMultiplierPerPayer: 64,
  hardWinMultiplier: 2,
  patterns,
  eventMultipliers: Object.freeze({ discard: 1, 'self-draw': 2, 'robbed-kong': 2, 'kong-bloom': 4 }),
  openingMinimumMultiplier: 8,
  kongPayments: Object.freeze({ discard: 1, added: 1, concealed: 2, wind: 2 }),
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

/** Local acceptance passed; WS rooms live behind real two-client smoke; P2P still requires real SDK acceptance. */
export const BLOOD_FLOW_AVAILABILITY = Object.freeze({ local: true, ws: true, p2p: false })

export const BLOOD_FLOW_TIMING = Object.freeze({
  winBeatMs: 450, normalDecisionMs: 15_000, remoteDecisionMs: 25_000, recoveryGraceMs: 12_000,
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
  /** LLM 候选注入同源 EV 特征并以其为默认推荐（模型可覆盖、要理由）；关闭则回退旧提示词。 */
  readonly llmEvFeatures: boolean
}

export const BLOOD_FLOW_AI: BloodFlowAiConfig = Object.freeze({
  strategy: 'ev',
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
  llmEvFeatures: true,
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
