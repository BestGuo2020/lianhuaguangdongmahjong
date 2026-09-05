import { describe, expect, it } from 'vitest'
import golden from './fixtures/golden.json'
import scoring from './fixtures/scoring.json'
import type { GoldenScoreCase, GoldenWinCase } from './fixtures/types'
import { evaluateWin } from './evaluate'
import { compareScores, scorePatterns } from './score'

describe('E02 actual evaluator golden acceptance', () => {
  it.each(golden.cases as readonly GoldenWinCase[])('$id', ({ input, expected }) => {
    const result = evaluateWin(input)
    expect(Boolean(result)).toBe(expected.winning)
    if (!expected.winning) return
    const ids = result!.score.items.map(p => p.id)
    for (const id of expected.includes ?? []) expect(ids).toContain(id)
    for (const id of expected.excludes ?? []) expect(ids).not.toContain(id)
    if (expected.shape) expect(result!.decomposition.shape).toBe(expected.shape)
    if (expected.hardWin !== undefined) expect(result!.score.hardWin).toBe(expected.hardWin)
    if (expected.paymentPerPayer !== undefined) expect(result!.score.paymentPerPayer).toBe(expected.paymentPerPayer)
    const assignments = result!.decomposition.assignments
    expect(assignments.map(a => a.inputIndex).sort((a, b) => a - b)).toEqual(Array.from({ length: input.concealed.length + 1 }, (_, n) => n))
    expect(assignments.map(a => a.physical)).toEqual([...input.concealed, input.winningTile])
    expect(result!.score.hardWin).toBe(assignments.every(a => a.physical === a.represented))
  })
  it.each(scoring.cases as readonly GoldenScoreCase[])('$id arithmetic and independent decomposition selection', ({ candidates, expected }) => {
    const scored = candidates.map(c => scorePatterns(c.patterns, c.natural, c.source, c.opening ? 'heaven' : null))
    const indexes = scored.map((_, i) => i).sort((a, b) => compareScores(scored[a], scored[b]))
    expect(indexes[0]).toBe(expected.candidateIndex)
    const best = scored[indexes[0]]
    expect(best.finalMultiplier).toBe(expected.finalMultiplier)
    expect(best.paymentPerPayer).toBe(expected.paymentPerPayer)
    expect(best.paymentPerPayer * (best.source === 'self-draw' || best.source === 'kong-bloom' ? 3 : 1)).toBe(expected.totalWon)
  })
})
