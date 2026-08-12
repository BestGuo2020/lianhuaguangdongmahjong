import { describe, expect, it, vi } from 'vitest'
import type { ActionContext } from '../../core/rules/actions'
import type { GamePlayer, TileType } from '../../core/contracts/types'
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

  it('可胡且同时可碰杠吃时合并询问，并在胡牌优先级确认后执行所选动作', async () => {
    const { state } = createOrchestrator()
    state.players[0].hand = [
      'm5', 'm5', 'm5', 'm3', 'm3', 'm4', 'm4',
      'm6', 'm6', 'p1', 'p1', 's1', 's1',
    ]
    state.players[3].discards = ['m5']
    state.jokerTiles.value = ['white']
    let responseContext: Parameters<LotusController['requestDiscardHu']>[0] | null = null
    const responseController: LotusController = {
      requestTurn: async () => ({ kind: 'discard', handIndex: 0 }),
      requestDiscardHu: async (context) => {
        responseContext = context
        return { kind: 'peng' }
      },
      requestClaim: async () => ({ kind: 'pass' }),
      requestChi: async () => ({ kind: 'pass' }),
      requestRobKong: async () => 'pass',
    }
    // createOrchestrator controllers are replaceable through their shared array only before construction,
    // so build a fresh orchestrator with the response-aware controller.
    const tableContext: ActionContext = {
      players: state.players,
      currentPlayer: state.currentPlayer,
      showTableAction: vi.fn(),
      showScoreFlow: vi.fn(),
      playSound: vi.fn(),
    }
    const controllers = [responseController, responseController, responseController, responseController]
    const responseOrchestrator = createLotusTurnOrchestrator({
      state, controllers, tableContext,
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
      later: (callback) => { callback(); return 0 },
    })

    responseOrchestrator.routeDiscard(3, 'm5')
    await Promise.resolve()
    await Promise.resolve()

    expect(responseContext).toMatchObject({ canPeng: true, canGang: true })
    expect(responseContext?.chiOptions).toHaveLength(2)
    expect(state.players[0].melds).toContainEqual({
      type: 'peng', tile: 'm5', from: 3, tiles: ['m5', 'm5', 'm5'],
    })
  })

  it('精牌弃出后仍可按普通牌面被碰', async () => {
    const state = createLotusGameState()
    state.players.push(
      player(0, ['m4', 'm4', 'p1']),
      player(1),
      player(2),
      player(3, [], ['m4']),
    )
    state.jokerTiles.value = ['m4']
    const responseController: LotusController = {
      requestTurn: async () => ({ kind: 'discard', handIndex: 0 }),
      requestDiscardHu: async () => ({ kind: 'pass' }),
      requestClaim: async () => ({ kind: 'peng' }),
      requestChi: async () => ({ kind: 'pass' }),
      requestRobKong: async () => 'pass',
    }
    const controllers = [responseController, responseController, responseController, responseController]
    const tableContext: ActionContext = {
      players: state.players,
      currentPlayer: state.currentPlayer,
      showTableAction: vi.fn(),
      showScoreFlow: vi.fn(),
      playSound: vi.fn(),
    }
    const orchestrator = createLotusTurnOrchestrator({
      state, controllers, tableContext,
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
      later: (callback) => { callback(); return 0 },
    })

    orchestrator.routeDiscard(3, 'm4')
    await Promise.resolve()
    await Promise.resolve()

    expect(state.players[0].melds).toContainEqual({
      type: 'peng', tile: 'm4', from: 3, tiles: ['m4', 'm4', 'm4'],
    })
  })
})
