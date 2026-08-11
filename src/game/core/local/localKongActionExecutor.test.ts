import { describe, expect, it, vi } from 'vitest'
import type { GamePlayer } from '../contracts/types'
import { createLocalGameState } from './localGameState'
import { createLocalKongActionExecutor } from './localKongActionExecutor'

function player(seat: number, hand: GamePlayer['hand'] = []): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand,
    discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

describe('localKongActionExecutor', () => {
  it('executes a concealed kong, scores it, and schedules one tail draw', async () => {
    const state = createLocalGameState()
    state.players.push(
      player(0, ['m1', 'm1', 'm1', 'm1', 'p2']),
      player(1), player(2), player(3),
    )
    const showTableAction = vi.fn()
    const showScoreFlow = vi.fn()
    const beginTurn = vi.fn()
    const scheduled: Array<() => void> = []
    const executor = createLocalKongActionExecutor({
      state,
      showTableAction,
      showScoreFlow,
      playSound: vi.fn(),
      later: (callback) => { scheduled.push(callback); return 1 },
      beginTurn,
    })

    await executor.performConcealedKong(0, 'm1')

    expect(state.players[0].hand).toEqual(['p2'])
    expect(state.players[0].melds[0]).toMatchObject({ type: 'angang', tile: 'm1' })
    expect(state.players.map((item) => item.score)).toEqual([1600, 800, 800, 800])
    expect(showTableAction).toHaveBeenCalledWith('concealed-gang', 0, null, 'm1', 0)
    expect(showScoreFlow).toHaveBeenCalledOnce()

    scheduled[0]()
    expect(beginTurn).toHaveBeenCalledWith(0, { fromTail: true })
  })
})
