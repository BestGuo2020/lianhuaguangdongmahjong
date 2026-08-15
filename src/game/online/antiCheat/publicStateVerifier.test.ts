import { describe, expect, it } from 'vitest'
import { verifySnapshot } from './publicStateVerifier'
import type { ServerSnapshot } from '../protocol/dto'

function snapshot(overrides: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    kind: 'state_snapshot',
    roomId: 'R',
    mode: 'east',
    phase: 'discard',
    round: 1,
    dealer: 0,
    honba: 0,
    wallCount: 3,
    wall: ['m1', 'm2', 'm3'],
    headDrawn: 1,
    currentPlayer: 0,
    players: [
      { name: 'P0', avatar: '', score: 1000, seat: 0, hand: ['m1'], discards: [], melds: [], redCount: 0, drawnTileIndex: -1 },
      { name: 'P1', avatar: '', score: 1000, seat: 1, hand: [null, null], discards: [], melds: [], redCount: 0, drawnTileIndex: -1 },
      { name: 'P2', avatar: '', score: 1000, seat: 2, hand: [null], discards: [], melds: [], redCount: 0, drawnTileIndex: -1 },
      { name: 'P3', avatar: '', score: 1000, seat: 3, hand: [], discards: [], melds: [], redCount: 0, drawnTileIndex: -1 },
    ],
    seat: 0,
    result: null,
    announcement: null,
    matchFinished: false,
    lastDiscard: null,
    winPresentation: null,
    winningPlayerIndex: -1,
    ...overrides,
  }
}

describe('verifySnapshot', () => {
  it('合法快照无违规', () => {
    expect(verifySnapshot(snapshot())).toEqual([])
  })

  it('wallCount 与 wall 长度不符 → 违规', () => {
    const violations = verifySnapshot(snapshot({ wallCount: 5 }))
    expect(violations.some((v) => v.code === 'WALL_COUNT')).toBe(true)
  })

  it('座位重复 → 违规', () => {
    const players = snapshot().players
    players[1] = { ...players[1], seat: 0 }
    const violations = verifySnapshot(snapshot({ players }))
    expect(violations.some((v) => v.code === 'DUP_SEAT')).toBe(true)
  })

  it('手牌半透明（混 null 与真实牌）→ 违规', () => {
    const players = snapshot().players
    players[0] = { ...players[0], hand: ['m1', null] as (string | null)[] }
    const violations = verifySnapshot(snapshot({ players }))
    expect(violations.some((v) => v.code === 'HAND_MIX')).toBe(true)
  })
})
