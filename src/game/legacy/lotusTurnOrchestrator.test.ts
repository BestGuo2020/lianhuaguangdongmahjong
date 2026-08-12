import { describe, expect, it, vi } from 'vitest'
import type { ActionContext } from '../core/rules/actions'
import type { GamePlayer, TileType } from '../core/contracts/types'
import type { LotusController } from './lotusControllers'
import { createLotusGameState } from './lotusState'
import { createLotusTurnOrchestrator } from './lotusTurnOrchestrator'

function player(seat: number, hand: TileType[] = [], discards: TileType[] = []): GamePlayer {
  return {
    name: `player-${seat}`,
    avatar: '',
    score: 2000,
    seat,
    hand,
    discards,
    melds: [],
    redCount: 0,
    drawnTileIndex: -1,
  }
}

function createOrchestrator() {
  const state = createLotusGameState()
  state.players.push(
    player(0, ['m5', 'm6', 'p1']),
    player(1),
    player(2),
    player(3, [], ['m4']),
  )
  const tableContext: ActionContext = {
    players: state.players,
    currentPlayer: state.currentPlayer,
    showTableAction: vi.fn(),
    showScoreFlow: vi.fn(),
    playSound: vi.fn(),
  }
  const controllers = Array.from({ length: 4 }, () => ({})) as LotusController[]
  const orchestrator = createLotusTurnOrchestrator({
    state,
    controllers,
    tableContext,
    structuralMeldCount: () => 0,
    drawFor: async () => true,
    performConcealedKong: async () => {},
    performWindKong: async () => {},
    declareAddedKong: () => {},
    settleAddedKong: () => undefined,
    discardTile: () => undefined,
    endDraw: () => undefined,
    endGame: () => undefined,
    announce: () => {},
    later: () => 0,
  })
  return { state, orchestrator }
}

describe('莲花麻将吃牌副露', () => {
  it('保留上家实际打出的牌作为吃副露的 meld.tile', () => {
    const { state, orchestrator } = createOrchestrator()
    const meld = { kind: 'sequence' as const, tiles: ['m4', 'm5', 'm6'] as TileType[] }

    orchestrator.performChi(0, meld, 'm4', 3)

    expect(state.players[3].discards).toEqual([])
    expect(state.players[0].melds).toEqual([{
      type: 'chi',
      tile: 'm4',
      from: 3,
      tiles: ['m4', 'm5', 'm6'],
    }])
  })
})
