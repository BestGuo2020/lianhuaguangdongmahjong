import { describe, expect, it, vi } from 'vitest'
import type { PlayerController } from '../controllers/playerController'
import type { GamePlayer } from '../contracts/types'
import { createLocalGameState } from './localGameState'
import { createLocalTurnOrchestrator } from './localTurnOrchestrator'

function player(seat: number, hand: GamePlayer['hand']): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand,
    discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

describe('localTurnOrchestrator', () => {
  it('offers a discard response to the nearest eligible seat first', async () => {
    const state = createLocalGameState()
    state.players.push(
      player(0, []),
      player(1, ['m1', 'm1', 'p2']),
      player(2, ['m1', 'm1', 's2']),
      player(3, []),
    )
    state.players[0].discards.push('m1')
    const requestClaim = vi.fn(async () => ({ kind: 'peng' as const, discardIndex: 2 }))
    const controllers = state.players.map((_, index) => ({
      requestTurn: vi.fn(),
      requestClaim: index === 1 ? requestClaim : vi.fn(),
      requestRobKong: vi.fn(),
    })) as unknown as PlayerController[]
    const later = vi.fn(() => 1)
    const orchestrator = createLocalTurnOrchestrator({
      state,
      controllers,
      tableContext: {
        players: state.players,
        currentPlayer: state.currentPlayer,
        showTableAction: vi.fn(),
        showScoreFlow: vi.fn(),
        playSound: vi.fn(),
      },
      structuralMeldCount: () => 0,
      drawFor: async () => true,
      performConcealedKong: async () => {},
      declareAddedKong: vi.fn(),
      settleAddedKong: vi.fn(),
      discardTile: vi.fn(),
      endDraw: vi.fn(),
      endGame: vi.fn(),
      announce: vi.fn(),
      later,
    })

    orchestrator.routeDiscard(0, 'm1')
    await Promise.resolve()
    await Promise.resolve()

    expect(requestClaim).toHaveBeenCalledOnce()
    expect(state.players[1].melds[0]).toMatchObject({ type: 'peng', tile: 'm1', from: 0 })
    expect(state.players[2].melds).toEqual([])
    expect(later).toHaveBeenCalledOnce()
  })

  it('手中有对子时，给本地玩家传递可碰状态', async () => {
    const state = createLocalGameState()
    state.players.push(
      player(0, []),
      player(1, ['m9', 'm9', 'p2']),
      player(2, []),
      player(3, []),
    )
    state.players[0].discards.push('m9')
    const requestClaim = vi.fn(async () => ({ kind: 'pass' as const }))
    const controllers = state.players.map((_, index) => ({
      requestTurn: vi.fn(),
      requestClaim: index === 1 ? requestClaim : vi.fn(),
      requestRobKong: vi.fn(),
    })) as unknown as PlayerController[]
    const orchestrator = createLocalTurnOrchestrator({
      state,
      controllers,
      tableContext: {
        players: state.players,
        currentPlayer: state.currentPlayer,
        showTableAction: vi.fn(),
        showScoreFlow: vi.fn(),
        playSound: vi.fn(),
      },
      structuralMeldCount: () => 0,
      drawFor: async () => true,
      performConcealedKong: async () => {},
      declareAddedKong: vi.fn(),
      settleAddedKong: vi.fn(),
      discardTile: vi.fn(),
      endDraw: vi.fn(),
      endGame: vi.fn(),
      announce: vi.fn(),
      later: vi.fn(() => 1),
    })

    orchestrator.routeDiscard(0, 'm9')
    await Promise.resolve()
    await Promise.resolve()

    expect(requestClaim).toHaveBeenCalledWith(expect.objectContaining({ canPeng: true, canGang: false }))
  })
})
