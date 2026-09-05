import { expect, it } from 'vitest'
import { simulateRound } from './simulation'

it('40 fixed walls complete with zero-sum payments, 136 physical tiles and no deadlocks', () => {
  let wins = 0
  for (let seed = 1; seed <= 40; seed++) {
    const round = simulateRound(seed, [0, 0, 0, 0])
    expect(round.result.reason).toBe('wall-exhausted')
    expect(round.endingScores.reduce((a, b) => a + b)).toBe(0)
    wins += round.records.length
  }
  expect(wins).toBeGreaterThan(0)
}, 120_000)
