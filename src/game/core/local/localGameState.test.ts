import { describe, expect, it } from 'vitest'
import { createLocalGameState } from './localGameState'

describe('createLocalGameState', () => {
  it('creates isolated state for each local game instance', () => {
    const first = createLocalGameState()
    const second = createLocalGameState()

    first.phase.value = 'drawing'
    first.players.push({
      name: 'A', avatar: '', score: 1000, seat: 0,
      hand: [], discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
    })

    expect(second.phase.value).toBe('lobby')
    expect(second.players).toEqual([])
    expect(first.dealAnimation.value).toEqual({ playerIndex: -1, count: 0, serial: 0 })
  })
})
