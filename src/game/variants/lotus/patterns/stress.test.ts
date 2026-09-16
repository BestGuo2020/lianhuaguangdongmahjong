import { expect, it } from 'vitest'
import { evaluateWin } from './evaluate'

it('scores eight jokers plus four limited whiteboards without cutting off solutions', () => {
  const result = evaluateWin({
    concealed: ['m1', 'm1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm2', 'white', 'white', 'white', 'white', 'p1'],
    winningTile: 'p1', melds: [], jokers: ['m1', 'm2'], source: 'self-draw', opening: null,
  })
  expect(result).not.toBeNull()
  // 2026-09-15 番表变更后为 114：口径改为 Σ(番值)，且门清成为独立番种（本手无副露 → +1 番），硬胡 ×2。
  // Four limited whiteboards cannot all represent winds/dragons, so no bigger honor hand.
  expect(result!.score.finalMultiplier).toBe(114)
}, 60_000)
