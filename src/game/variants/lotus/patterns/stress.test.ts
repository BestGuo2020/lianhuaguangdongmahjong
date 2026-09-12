import { expect, it } from 'vitest'
import { evaluateWin } from './evaluate'

it('scores eight jokers plus four limited whiteboards without cutting off solutions', () => {
  const result = evaluateWin({
    concealed: ['m1', 'm1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm2', 'white', 'white', 'white', 'white', 'p1'],
    winningTile: 'p1', melds: [], jokers: ['m1', 'm2'], source: 'self-draw', opening: null,
  })
  expect(result).not.toBeNull()
  // 2026-09-12 番值表重平衡后：四暗刻(16) + 清幺九(24) + 字一色(24) 等档位整体上调，硬胡 ×2 → 122。
  // Four limited whiteboards cannot all represent winds/dragons, so no bigger honor hand.
  expect(result!.score.finalMultiplier).toBe(122)
}, 60_000)
