import { expect, it } from 'vitest'
import { evaluateWin } from './evaluate'

it('scores eight jokers plus four limited whiteboards without cutting off solutions', () => {
  const result = evaluateWin({
    concealed: ['m1', 'm1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm2', 'white', 'white', 'white', 'white', 'p1'],
    winningTile: 'p1', melds: [], jokers: ['m1', 'm2'], source: 'self-draw', opening: null,
  })
  expect(result).not.toBeNull()
  // Four concealed triplets (8) + pure terminals (16): (1 + 7 + 15) × 2.
  // Four limited whiteboards cannot all represent winds/dragons, so no bigger honor hand.
  expect(result!.score.finalMultiplier).toBe(46)
}, 60_000)
