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
const requiredWeights: Record<RegularPatternId, number> = {
  'pure-suit': 4, 'mixed-suit': 2, 'all-triplets': 2,
  'little-three-dragons': 4, 'big-three-dragons': 8,
  'little-four-winds': 8, 'big-four-winds': 16, 'nine-gates': 16,
  'all-green': 16, 'pure-terminals': 16, 'mixed-terminals': 4,
  'three-concealed-triplets': 4, 'four-concealed-triplets': 8,
  'all-honors': 8, 'three-kongs': 8, 'four-kongs': 16,
}

describe('E01 blood-flow acceptance contract (not evaluator acceptance)', () => {
  it.each(Object.entries(requiredWeights))('%s has its specified weight and positive/negative oracles', (id, weight) => {
    expect(BLOOD_FLOW_CONFIG.patterns[id]).toMatchObject({ id, weight })
    expect(cases.some(c => c.expected.includes?.includes(id as RegularPatternId))).toBe(true)
    expect(cases.some(c => c.expected.excludes?.includes(id as RegularPatternId))).toBe(true)
  })

  it('versions fixtures and keeps modifier, old rules, and rollout independent', () => {
    expect(golden.ruleVersion).toBe(BLOOD_FLOW_CONFIG.version)
    expect(scores.ruleVersion).toBe(BLOOD_FLOW_CONFIG.version)
    expect(Object.keys(BLOOD_FLOW_CONFIG.patterns)).toHaveLength(21)
    expect(BLOOD_FLOW_CONFIG.patterns.thirteenOrphans.weight).toBe(16)
    expect(BLOOD_FLOW_CONFIG.patterns).not.toHaveProperty('hard-win')
    expect(BLOOD_FLOW_CONFIG.hardWinMultiplier).toBe(2)
    expect(LOTUS_RULESET.baseScore).toBe(100)
    expect(LOTUS_RULESET.flow).toMatchObject({ mode: 'single-win', continueAfterWin: false, allowMultipleWinners: false })
    expect(BLOOD_FLOW_AVAILABILITY).toEqual({ local: false, p2p: false })
    expect(Object.isFrozen(BLOOD_FLOW_CONFIG.patterns['four-kongs'].excludes)).toBe(true)
  })

  it('rejects missing/duplicated fixture identities and preserves the specified arithmetic examples', () => {
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length)
    expect(new Set(scoringCases.map(c => c.id)).size).toBe(scoringCases.length)
    expect(cases.find(c => c.id === 'hard-orphans-discard')?.expected.paymentPerPayer).toBe(320)
    expect(cases.find(c => c.id === 'hard-orphans-self-draw')?.expected.paymentPerPayer).toBe(640)
    expect(cases.find(c => c.id === 'hard-pure-triplets-self-draw')?.expected.paymentPerPayer).toBe(200)
  })

  it.each(cases)('$id uses physical tiles and a separate single winning tile', ({ input, expected }) => {
    const physical = [...input.concealed, input.winningTile, ...input.melds.flatMap(m => m.tiles)]
    for (const tile of physical) expect(TILE_TYPES).toContain(tile)
    for (const tile of new Set(physical)) expect(physical.filter(t => t === tile).length).toBeLessThanOrEqual(4)
    expect(input.concealed.length + 1 + input.melds.length * 3).toBe(14)
    if (expected.paymentPerPayer !== undefined) {
      expect(Number.isSafeInteger(expected.paymentPerPayer)).toBe(true)
      expect(expected.paymentPerPayer).toBeLessThanOrEqual(640)
    }
    for (const id of [...(expected.includes ?? []), ...(expected.excludes ?? [])]) {
      expect(BLOOD_FLOW_CONFIG.patterns).toHaveProperty(id)
    }
  })
})
