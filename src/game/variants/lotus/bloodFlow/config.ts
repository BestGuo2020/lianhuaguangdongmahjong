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

/** Local acceptance passed. P2P still requires real SDK acceptance; WS has no flag. */
export const BLOOD_FLOW_AVAILABILITY = Object.freeze({ local: true, p2p: false })

export const BLOOD_FLOW_TIMING = Object.freeze({
  winBeatMs: 450, normalDecisionMs: 15_000, remoteDecisionMs: 25_000, recoveryGraceMs: 12_000,
  compactWinMs: 2300, largeWinMs: 2600, topWinMs: 2900, multiWinIntroMs: 1500,
  fullEffectCooldownMs: 8000, visualBacklogMs: 2000,
})

/** Shared by the local continuation and the existing DOM/3D director. */
export function bloodFlowWinTiming(tier: number) {
  if (tier >= 2) {
    const duration = tier === 3 ? BLOOD_FLOW_TIMING.topWinMs : BLOOD_FLOW_TIMING.largeWinMs
    const impact = tier === 3 ? 1110 : 1000
    return { duration, phaseMarks: { intro: 0, focus: 0, impact, readable: tier === 3 ? 1390 : 1240, score: duration - 620, exit: duration - 200 } }
  }
  return { duration: BLOOD_FLOW_TIMING.compactWinMs, phaseMarks: { intro: 0, focus: 0, impact: 870, readable: 1090, score: 1815, exit: 2050 } }
}
