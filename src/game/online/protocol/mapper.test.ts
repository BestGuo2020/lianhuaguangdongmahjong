import { describe, expect, it } from 'vitest'
import type { GamePlayer, TableActionEvent } from '../../core/contracts/types'
import type { ServerSnapshot } from './dto'
import {
  mapScoreDeltasToLocal,
  mapServerSnapshotToLocal,
  mapTableActionToLocal,
  toLocalSeat,
} from './mapper'

function player(seat: number, overrides: Partial<GamePlayer> = {}): GamePlayer {
  return {
    name: `P${seat}`,
    avatar: '',
    score: 1000,
    seat,
    hand: [],
    discards: [],
    melds: [],
    redCount: 0,
    drawnTileIndex: -1,
    ...overrides,
  }
}

function snapshot(): ServerSnapshot {
  return {
    kind: 'state_snapshot',
    roomId: 'ROOM01',
    mode: 'east',
    phase: 'settled',
    round: 1,
    dealer: 0,
    honba: 0,
    dice: [2, 5],
    wallCount: 60,
    wall: ['m1'],
    headDrawn: 20,
    currentPlayer: 3,
    players: [
      player(0),
      player(1, {
        melds: [{ type: 'peng', tile: 'm2', tiles: ['m2', 'm2', 'm2'], from: 3 }],
      }),
      player(2, { avatar: '/custom/me.png' }),
      player(3),
    ],
    seat: 2,
    result: {
      winnerIndex: 3,
      robbedKongPlayerIndex: 1,
      tenpai: [2, 0],
      scoreChanges: [
        { playerIndex: 0, name: 'P0', avatar: '', score: 900, delta: -100 },
        { playerIndex: 3, name: 'P3', avatar: '/custom/p3.png', score: 1300, delta: 300 },
      ],
    },
    announcement: { text: '结算', tone: 'gold', id: 10 },
    matchFinished: false,
    lastDiscard: { tile: 's9', from: 1, id: 8 },
    winPresentation: {
      winnerIndex: 3,
      tile: 's9',
      sourceIndex: 0,
      robbedKong: true,
      robbedKongPlayerIndex: 1,
      robbedKongMeldIndex: 0,
    },
    winningPlayerIndex: 3,
  }
}

describe('protocol seat mapper', () => {
  it('maps every seat-sensitive snapshot field into the local perspective', () => {
    const source = snapshot()
    const mapped = mapServerSnapshotToLocal(source, 2)

    expect(mapped.players.map((item) => item.seat)).toEqual([2, 3, 0, 1])
    expect(mapped.players[0].avatar).toBe('/custom/me.png')
    expect(mapped.players[3].melds[0].from).toBe(1)
    expect(mapped.players[2].avatar).toContain('lotus')
    expect(mapped.currentPlayer).toBe(1)
    expect(mapped.dealer).toBe(2)
    expect(mapped.winningPlayerIndex).toBe(1)
    expect(mapped.lastDiscard?.from).toBe(3)

    expect(mapped.result).toMatchObject({
      winnerIndex: 1,
      robbedKongPlayerIndex: 3,
      tenpai: [0, 2],
    })
    expect(mapped.result?.scoreChanges[0]).toMatchObject({ playerIndex: 2 })
    expect(mapped.result?.scoreChanges[0].avatar).toContain('lotus')
    expect(mapped.result?.scoreChanges[0].fallbackAvatar).toContain('lotus')
    expect(mapped.result?.scoreChanges[1]).toMatchObject({
      playerIndex: 1,
      avatar: '/custom/p3.png',
    })

    expect(mapped.winPresentation).toMatchObject({
      winnerIndex: 1,
      sourceIndex: 2,
      robbedKongPlayerIndex: 3,
    })
  })

  it('does not mutate the server DTO while mapping nested players and results', () => {
    const source = snapshot()
    const original = structuredClone(source)

    mapServerSnapshotToLocal(source, 2)

    expect(source).toEqual(original)
  })

  it('preserves negative sentinel seats', () => {
    const source = snapshot()
    source.currentPlayer = -1
    source.winningPlayerIndex = -1
    source.winPresentation!.sourceIndex = -1
    source.winPresentation!.robbedKongPlayerIndex = -1

    const mapped = mapServerSnapshotToLocal(source, 2)

    expect(mapped.currentPlayer).toBe(-1)
    expect(mapped.winningPlayerIndex).toBe(-1)
    expect(mapped.winPresentation?.sourceIndex).toBe(-1)
    expect(mapped.winPresentation?.robbedKongPlayerIndex).toBe(-1)
  })

  it('maps hidden server tiles into an explicit concealed count without leaking null into core state', () => {
    const source = snapshot()
    source.players[0].hand = Array(13).fill(null)
    source.players[2].hand = ['m1', 'm2', 'm3']

    const mapped = mapServerSnapshotToLocal(source, 2)

    expect(mapped.players[0]).toMatchObject({ seat: 2, hand: ['m1', 'm2', 'm3'], concealedTileCount: 3 })
    expect(mapped.players[2]).toMatchObject({ seat: 0, hand: [], concealedTileCount: 13 })
    expect(mapped.players.flatMap((item) => item.hand)).not.toContain(null)
  })
})

describe('protocol event mapper', () => {
  it('maps table actions and score flows with the same seat rotation', () => {
    const event: TableActionEvent = {
      id: 1,
      type: 'discard-gang',
      actorIndex: 3,
      sourceIndex: 0,
      tile: 'm5',
      meldIndex: 0,
    }

    expect(mapTableActionToLocal(event, 2)).toMatchObject({ actorIndex: 1, sourceIndex: 2 })
    expect(mapScoreDeltasToLocal([
      { playerIndex: 2, amount: 300 },
      { playerIndex: 1, amount: -100 },
    ], 2)).toEqual([
      { playerIndex: 0, amount: 300 },
      { playerIndex: 3, amount: -100 },
    ])
    expect(toLocalSeat(0, 2)).toBe(2)
  })
})
