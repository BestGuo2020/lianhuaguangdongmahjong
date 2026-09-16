import { describe, expect, it } from 'vitest'
import golden from '../patterns/fixtures/golden.json'
import scores from '../patterns/fixtures/scoring.json'
import type { GoldenScoreCase, GoldenWinCase } from '../patterns/fixtures/types'
import type { RegularPatternId } from '../patterns/types'
import { TILE_TYPES } from '../../../core/rules/tiles'
import { LOTUS_RULESET } from '../lotusRules'
import { BLOOD_FLOW_AVAILABILITY, BLOOD_FLOW_CONFIG } from './config'

const cases = golden.cases as readonly GoldenWinCase[]
const scoringCases = scores.cases as readonly GoldenScoreCase[]
// 2026-09-12 第二版番种表的权重（用户定稿：梯度 1→2→4→6→8→12→16→24→32；门清已按用户决定取消）
const requiredWeights: Record<RegularPatternId, number> = {
  'pure-suit': 8, 'mixed-suit': 4, 'all-triplets': 4,
  'little-three-dragons': 16, 'big-three-dragons': 24,
  'little-four-winds': 16, 'big-four-winds': 32, 'nine-gates': 32,
  'all-green': 24, 'pure-terminals': 24, 'mixed-terminals': 12,
  'three-concealed-triplets': 6, 'four-concealed-triplets': 16,
  'all-honors': 24, 'three-kongs': 12, 'four-kongs': 32,
  // 新增路线牌型（正反例见 patterns/midTierPatterns.test.ts）
  // 2026-09-15 定案：门清（只看无副露，与任何番种叠加）1 番；平胡（存在全顺无刻子拆解）1 番；
  // 鸡胡（无任何计分番种时的兜底）0.5 番；原「门清平胡」2 番合并番种已删除。
  'all-simples': 2, 'concealed-hand': 1, 'all-with-terminals': 4,
  'one-suit-three-steps': 4, 'one-suit-four-steps': 8, 'pure-straight': 6,
  'one-suit-three-joints': 8, 'one-suit-four-joints': 16,
}
/** 这些番种的正反例由 golden fixture 覆盖（新增番种改由 midTierPatterns.test.ts 覆盖）。 */
const ORACLE_COVERED = new Set<RegularPatternId>(['pure-suit', 'mixed-suit', 'all-triplets', 'little-three-dragons',
  'big-three-dragons', 'little-four-winds', 'big-four-winds', 'nine-gates', 'all-green', 'pure-terminals',
  'mixed-terminals', 'three-concealed-triplets', 'four-concealed-triplets', 'all-honors', 'three-kongs', 'four-kongs'])

describe('E01 blood-flow acceptance contract (not evaluator acceptance)', () => {
  it.each(Object.entries(requiredWeights))('%s has its specified weight and positive/negative oracles', (id, weight) => {
    expect(BLOOD_FLOW_CONFIG.patterns[id]).toMatchObject({ id, weight })
    if (!ORACLE_COVERED.has(id as RegularPatternId)) return
    expect(cases.some(c => c.expected.includes?.includes(id as RegularPatternId))).toBe(true)
    expect(cases.some(c => c.expected.excludes?.includes(id as RegularPatternId))).toBe(true)
  })

  it('versions fixtures and keeps modifier, old rules, and rollout independent', () => {
    expect(golden.ruleVersion).toBe(BLOOD_FLOW_CONFIG.version)
    expect(scores.ruleVersion).toBe(BLOOD_FLOW_CONFIG.version)
    // 31 = 原 30 项 + 新增兜底番种「鸡胡」（0.5 番）；门清/平胡沿用原 id（语义改写）
    expect(Object.keys(BLOOD_FLOW_CONFIG.patterns)).toHaveLength(31)
    expect(BLOOD_FLOW_CONFIG.patterns.chicken.weight).toBe(0.5)
    expect(BLOOD_FLOW_CONFIG.patterns.pinghu).toMatchObject({ label: '平胡', weight: 1 })
    expect(BLOOD_FLOW_CONFIG.patterns['concealed-hand']).toMatchObject({ label: '门清', weight: 1 })
    // 十三幺 2026-09-15 由 16 → 32（实测 1200 局仅 4 次，全表最稀有，赔付却低于豪华七对）
    expect(BLOOD_FLOW_CONFIG.patterns.thirteenOrphans.weight).toBe(32)
    expect(BLOOD_FLOW_CONFIG.patterns['luxury-seven-pairs'].weight).toBe(12)
    expect(BLOOD_FLOW_CONFIG.patterns).not.toHaveProperty('hard-win')
    expect(BLOOD_FLOW_CONFIG.hardWinMultiplier).toBe(2)
    expect(LOTUS_RULESET.baseScore).toBe(100)
    expect(LOTUS_RULESET.flow).toMatchObject({ mode: 'single-win', continueAfterWin: false, allowMultipleWinners: false })
    // 本地 / WS / P2P 三面均已放行（P2P 于 2026-09-10 打开，用于部署环境整场验收）。
    expect(BLOOD_FLOW_AVAILABILITY).toEqual({ local: true, ws: true, p2p: true })
    expect(Object.isFrozen(BLOOD_FLOW_CONFIG.patterns['four-kongs'].excludes)).toBe(true)
  })

  it('rejects missing/duplicated fixture identities and preserves the specified arithmetic examples', () => {
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length)
    expect(new Set(scoringCases.map(c => c.id)).size).toBe(scoringCases.length)
    expect(cases.find(c => c.id === 'hard-orphans-discard')?.expected.paymentPerPayer).toBe(660)
    expect(cases.find(c => c.id === 'hard-orphans-self-draw')?.expected.paymentPerPayer).toBe(1280)
    expect(cases.find(c => c.id === 'hard-pure-triplets-self-draw')?.expected.paymentPerPayer).toBe(480)
  })

  it.each(cases)('$id uses physical tiles and a separate single winning tile', ({ input, expected }) => {
    const physical = [...input.concealed, input.winningTile, ...input.melds.flatMap(m => m.tiles)]
    for (const tile of physical) expect(TILE_TYPES).toContain(tile)
    for (const tile of new Set(physical)) expect(physical.filter(t => t === tile).length).toBeLessThanOrEqual(4)
    expect(input.concealed.length + 1 + input.melds.length * 3).toBe(14)
    if (expected.paymentPerPayer !== undefined) {
      expect(Number.isSafeInteger(expected.paymentPerPayer)).toBe(true)
      expect(expected.paymentPerPayer).toBeLessThanOrEqual(BLOOD_FLOW_CONFIG.maxMultiplierPerPayer * BLOOD_FLOW_CONFIG.basePoints)
    }
    for (const id of [...(expected.includes ?? []), ...(expected.excludes ?? [])]) {
      expect(BLOOD_FLOW_CONFIG.patterns).toHaveProperty(id)
    }
  })
})
