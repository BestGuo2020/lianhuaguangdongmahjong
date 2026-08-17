import { describe, expect, it, vi } from 'vitest'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import type { PlayerController } from '../../core/controllers/playerController'
import { createLocalGameState } from '../../core/local/localGameState'
import { createLocalTurnOrchestrator } from '../../core/local/localTurnOrchestrator'
import { createLotusGameState } from '../../variants/lotus/lotusState'
import { createLotusTurnOrchestrator } from '../../variants/lotus/lotusTurnOrchestrator'
import { createLotusSettlement } from '../../variants/lotus/lotusSettlement'
import type { LotusController } from '../../variants/lotus/lotusControllers'
import { LotusRemotePlayerController } from './lotusRemotePlayerController'
import { RemotePlayerController } from './remotePlayerController'
import { createMockVibeRoom } from './mockVibeRoom'

const WINNING_SELF_DRAW: TileType[] = [
  'm1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'm5', 'm5',
]
const DISCARD_WAIT: TileType[] = [
  'm1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 'east', 'east', 'm7', 'm8',
]
const ROB_KONG_WAIT: TileType[] = [
  'm1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'm5',
]

function player(seat: number, hand: TileType[] = []): GamePlayer {
  return {
    name: `P${seat}`,
    avatar: '',
    score: 1000,
    seat,
    hand,
    discards: [],
    melds: [],
    redCount: 0,
    drawnTileIndex: hand.length - 1,
  }
}

const noopClassicController: PlayerController = {
  requestTurn: async () => ({ kind: 'discard', handIndex: 0 }),
  requestClaim: async () => ({ kind: 'pass' }),
  requestRobKong: async () => 'pass',
}

const noopLotusController: LotusController = {
  requestTurn: async () => ({ kind: 'discard', handIndex: 0 }),
  requestDiscardHu: async () => ({ kind: 'pass' }),
  requestClaim: async () => ({ kind: 'pass' }),
  requestChi: async () => ({ kind: 'pass' }),
  requestRobKong: async () => 'pass',
}

function classicTable(state: ReturnType<typeof createLocalGameState>) {
  return {
    players: state.players,
    currentPlayer: state.currentPlayer,
    showTableAction: vi.fn(),
    showScoreFlow: vi.fn(),
    playSound: vi.fn(),
  }
}

function lotusTable(state: ReturnType<typeof createLotusGameState>) {
  return {
    players: state.players,
    currentPlayer: state.currentPlayer,
    showTableAction: vi.fn(),
    showScoreFlow: vi.fn(),
    playSound: vi.fn(),
  }
}

describe('remote hu authority checks', () => {
  it('lotus settlement entry rejects a forged non-winning self-draw', () => {
    const state = createLotusGameState()
    state.phase.value = 'thinking'
    state.players.push(player(0, ['m1']), player(1), player(2), player(3))
    const timeline = createLotusSettlement({
      state,
      clearTimers: vi.fn(),
      later: vi.fn(),
      playSound: vi.fn(),
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '��һ��',
    })

    timeline.endGame(0, { selfDraw: true, winHand: ['m1'] })

    expect(state.phase.value).toBe('thinking')
    expect(state.result.value).toBeNull()
  })

  it('classic: a malicious remote hu on a non-winning self-draw is discarded, while a legal hu settles', async () => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.wall.value = ['m9']
    state.players.push(player(0, ['m1']), player(1), player(2), player(3))
    const room = createMockVibeRoom()
    const remote = new RemotePlayerController(room, 'peer1')
    const endGame = vi.fn()
    const discardTile = vi.fn()
    const orchestrator = createLocalTurnOrchestrator({
      state,
      controllers: [remote, noopClassicController, noopClassicController, noopClassicController],
      tableContext: classicTable(state),
      structuralMeldCount: () => 0,
      drawFor: async () => true,
      performConcealedKong: async () => {},
      declareAddedKong: vi.fn(),
      settleAddedKong: vi.fn(),
      discardTile,
      endDraw: vi.fn(),
      endGame,
      announce: vi.fn(),
      later: vi.fn(),
    })

    const attack = orchestrator.beginTurn(0)
    await Promise.resolve()
    await Promise.resolve()
    room.emit('peer1', { type: 'hu' })
    await attack

    expect(endGame).not.toHaveBeenCalled()
    expect(discardTile).toHaveBeenCalledWith(0, 0)

    state.players[0].hand = [...WINNING_SELF_DRAW]
    const legal = orchestrator.beginTurn(0)
    await Promise.resolve()
    await Promise.resolve()
    room.emit('peer1', { type: 'hu' })
    await legal

    expect(endGame).toHaveBeenCalledWith(0, { kongBloom: false })
  })

  it('lotus: a remote point-ron hu is rechecked against the authoritative discard context', async () => {
    const state = createLotusGameState()
    state.phase.value = 'thinking'
    state.players.push(player(0, [...DISCARD_WAIT]), player(1), player(2), player(3, []))
    state.players[3].discards = ['m9']
    const room = createMockVibeRoom()
    const remote = new LotusRemotePlayerController(room, 'peer1')
    const endGame = vi.fn()
    const orchestrator = createLotusTurnOrchestrator({
      state,
      controllers: [remote, noopLotusController, noopLotusController, noopLotusController],
      tableContext: lotusTable(state),
      structuralMeldCount: () => 0,
      drawFor: async () => true,
      performConcealedKong: async () => {},
      performWindKong: async () => {},
      declareAddedKong: vi.fn(),
      settleAddedKong: vi.fn(),
      discardTile: vi.fn(),
      endDraw: vi.fn(),
      endGame,
      announce: vi.fn(),
      later: vi.fn(),
    })

    orchestrator.routeDiscard(3, 'm9')
    await Promise.resolve()
    state.players[0].hand = ['m1']
    room.emit('peer1', { type: 'hu' })
    await Promise.resolve()
    await Promise.resolve()

    expect(endGame).not.toHaveBeenCalled()
  })

  it('lotus: a legal point-ron hu still reaches settlement with the authoritative win context', async () => {
    const state = createLotusGameState()
    state.phase.value = 'thinking'
    state.players.push(player(0, [...DISCARD_WAIT]), player(1), player(2), player(3, []))
    state.players[3].discards = ['m9']
    const room = createMockVibeRoom()
    const remote = new LotusRemotePlayerController(room, 'peer1')
    const endGame = vi.fn()
    const orchestrator = createLotusTurnOrchestrator({
      state,
      controllers: [remote, noopLotusController, noopLotusController, noopLotusController],
      tableContext: lotusTable(state),
      structuralMeldCount: () => 0,
      drawFor: async () => true,
      performConcealedKong: async () => {},
      performWindKong: async () => {},
      declareAddedKong: vi.fn(),
      settleAddedKong: vi.fn(),
      discardTile: vi.fn(),
      endDraw: vi.fn(),
      endGame,
      announce: vi.fn(),
      later: vi.fn(),
    })

    orchestrator.routeDiscard(3, 'm9')
    await Promise.resolve()
    room.emit('peer1', { type: 'hu' })
    await Promise.resolve()
    await Promise.resolve()

    expect(endGame).toHaveBeenCalledWith(0, expect.objectContaining({
      winTile: 'm9',
      sourceFrom: 3,
      winHand: [...DISCARD_WAIT, 'm9'],
    }))
  })

  it('lotus: malicious抢杠胡 is rejected after the authoritative hand changes, while legal抢杠胡 settles', async () => {
    const state = createLotusGameState()
    state.phase.value = 'thinking'
    state.players.push(player(0, ['m5']), player(1, [...ROB_KONG_WAIT]), player(2), player(3))
    state.players[0].melds = [{ type: 'peng', tile: 'm5', tiles: ['m5', 'm5', 'm5'] }]
    const room = createMockVibeRoom()
    const remote = new LotusRemotePlayerController(room, 'peer1')
    const endGame = vi.fn()
    const settleAddedKong = vi.fn()
    const orchestrator = createLotusTurnOrchestrator({
      state,
      controllers: [noopLotusController, remote, noopLotusController, noopLotusController],
      tableContext: lotusTable(state),
      structuralMeldCount: () => 0,
      drawFor: async () => true,
      performConcealedKong: async () => {},
      performWindKong: async () => {},
      declareAddedKong: vi.fn(),
      settleAddedKong,
      discardTile: vi.fn(),
      endDraw: vi.fn(),
      endGame,
      announce: vi.fn(),
      later: (callback) => { callback(); return 0 },
    })

    orchestrator.requestAddedKong(0, 0, 'm5')
    await Promise.resolve()
    state.players[1].hand = ['m1']
    room.emit('peer1', { type: 'hu' })
    await Promise.resolve()
    await Promise.resolve()

    expect(endGame).not.toHaveBeenCalled()
    expect(settleAddedKong).toHaveBeenCalledWith(0)

    state.players[1].hand = [...ROB_KONG_WAIT]
    settleAddedKong.mockClear()
    const legal = createLotusTurnOrchestrator({
      state,
      controllers: [noopLotusController, remote, noopLotusController, noopLotusController],
      tableContext: lotusTable(state),
      structuralMeldCount: () => 0,
      drawFor: async () => true,
      performConcealedKong: async () => {},
      performWindKong: async () => {},
      declareAddedKong: vi.fn(),
      settleAddedKong,
      discardTile: vi.fn(),
      endDraw: vi.fn(),
      endGame,
      announce: vi.fn(),
      later: (callback) => { callback(); return 0 },
    })
    legal.requestAddedKong(0, 0, 'm5')
    await Promise.resolve()
    room.emit('peer1', { type: 'hu' })
    await Promise.resolve()
    await Promise.resolve()

    expect(endGame).toHaveBeenCalledWith(1, expect.objectContaining({
      robbedKong: true,
      winTile: 'm5',
      sourceFrom: 0,
    }))
  })
})
