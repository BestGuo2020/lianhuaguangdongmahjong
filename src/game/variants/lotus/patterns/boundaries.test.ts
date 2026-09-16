import { describe, expect, it } from 'vitest'
import { evaluateWaits, evaluateWin } from './evaluate'
import { visitDecompositions } from './decompose'
import type { WinEvaluationInput } from '../bloodFlow/types'

const input: WinEvaluationInput = {
  concealed: ['m1', 'm1', 'm1', 'p2', 'p2', 'p2', 's4', 's4', 's4', 'red', 'red', 'red', 'east'],
  winningTile: 'east', source: 'discard', opening: null, jokers: [], melds: [],
}
describe('independent decomposition boundary checks', () => {
  it('winning triplet is exposed on discard but all four are concealed on self draw', () => {
    const concealed = [...input.concealed]; concealed[11] = 'east'
    const external = evaluateWin({ ...input, concealed, winningTile: 'red' })!
    const selfDraw = evaluateWin({ ...input, concealed, winningTile: 'red', source: 'self-draw' })!
    // 2026-09-15：门清改为独立番种（四暗刻的 excludes 里已移除它）。两手的共同点是"无副露"，
    // 因此两张成绩单都多出「门清」——注意门清只看副露，不看胡牌来源（点炮胡也算门清）。
    expect(external.score.items.map(p => p.id)).toEqual(['all-triplets', 'concealed-hand', 'three-concealed-triplets'])
    expect(selfDraw.score.items.map(p => p.id)).toEqual(['concealed-hand', 'four-concealed-triplets'])
  })
  it('physical fifth copy, incomplete meld and pending kong are invalid inputs', () => {
    expect(evaluateWin({ ...input, melds: [{ type: 'peng', tile: 'm1', tiles: ['m1', 'm1'] }], concealed: input.concealed.slice(3) })).toBeNull()
    expect(evaluateWin({ ...input, winningTile: 'm1', concealed: [...input.concealed.slice(0, 12), 'm1'] })).toBeNull()
  })
  it('includes exposed suit in classification and does not reinterpret it as a joker', () => {
    const result = evaluateWin({ ...input, concealed: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm5'],
      winningTile: 'm5', melds: [{ type: 'chi', tile: 'p1', tiles: ['p1', 'p2', 'p3'] }], jokers: ['p1', 'p2'] })!
    expect(result.score.hardWin).toBe(true)
    expect(result.score.items.map(p => p.id)).not.toContain('pure-suit')
  })
  it('declared kong excludes nine gates even with the corresponding closed tile ranks', () => {
    const result = evaluateWin({ ...input, concealed: ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm9', 'm9'],
      winningTile: 'm8', melds: [{ type: 'angang', tile: 'm1', tiles: ['m1', 'm1', 'm1', 'm1'] }] })!
    expect(result.score.items.map(p => p.id)).toContain('pure-suit')
    expect(result.score.items.map(p => p.id)).not.toContain('nine-gates')
  })
  it('self-draw and discard waits evaluate a wildcard as one physical instance', () => {
    const waits = evaluateWaits({ concealed: ['m1', 'm2', 'm3', 'p2', 'p3', 'p4', 's4', 's5', 's6', 'm6', 'm7', 'east', 'east'],
      jokers: ['south', 'west'], melds: [] })
    // 该手无副露 → 门清(1) + 平胡(1) = 2 番 × 自摸 2 = 4 倍 → 40 点（与旧「门清平胡 2 番」一致）
    expect(waits.find(w => w.tile === 'south')?.selfDraw?.paymentPerPayer).toBe(40)
    expect(waits.find(w => w.tile === 'south')?.discard).toBeNull()
    expect(waits.find(w => w.tile === 'm8')?.discard?.hardWin).toBe(true)
  })
  it('checks every represented assignment against its physical wildcard domain', () => {
    const sample: WinEvaluationInput = { ...input, concealed: ['m1', 'm2', 'm3', 'p2', 'p3', 'p4', 's4', 's5', 's6', 'm6', 'm7', 'white', 'east'],
      jokers: ['m8', 'm9'] }
    let count = 0
    visitDecompositions(sample, d => {
      count++
      for (const a of d.assignments) {
        if (a.inputIndex === sample.concealed.length) expect(a.represented).toBe(sample.winningTile)
        else if (a.physical === 'white') expect(['white', 'm8', 'm9']).toContain(a.represented)
        else if (!sample.jokers.includes(a.physical)) expect(a.represented).toBe(a.physical)
      }
    })
    // White fills m8, while the external east completes the natural pair.
    expect(count).toBe(1)
  })
  it('does not mutate authority-owned hand and meld arrays', () => {
    const before = JSON.stringify(input)
    evaluateWin(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
