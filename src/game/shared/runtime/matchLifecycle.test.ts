import { describe, expect, it, vi } from 'vitest'
import { createMatchLifecycle } from './matchLifecycle'
import type { TileType } from '../../core/contracts/types'

describe('matchLifecycle', () => {
  it('nextRound 将确定性开局参数转交给下一局 startGame', () => {
    const startGame = vi.fn()
    const lifecycle = createMatchLifecycle({
      state: {
        result: { value: { draw: true } },
        matchFinished: { value: false },
        round: { value: 1 },
        dealer: { value: 0 },
        honba: { value: 0 },
        matchType: { value: 'east' },
        phase: { value: 'settled' },
        winEffect: { value: null },
        winPresentation: { value: null },
        revealHands: { value: true },
        winningPlayerIndex: { value: -1 },
        players: [{}, {}, {}, {}],
      } as never,
      clearTimers: vi.fn(),
      startGame,
    })
    const opening = {
      initialWall: ['m1' as TileType],
      openingDice: [1, 2] as [number, number],
      openingSecondDice: [3, 4] as [number, number],
    }

    lifecycle.nextRound(opening)

    expect(startGame).toHaveBeenCalledWith(undefined, opening)
  })
})
