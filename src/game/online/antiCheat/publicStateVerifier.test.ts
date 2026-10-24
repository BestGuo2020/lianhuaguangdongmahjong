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

  it('客户端收到脱敏快照时允许缺少牌墙内容，并按累计进度校验牌墙', () => {
    expect(verifySnapshot(snapshot({ wall: undefined }))).toEqual([])
    // headDrawn 是累计值，合法地可以大于当前剩余牌数。
    expect(verifySnapshot(snapshot({ wall: undefined, wallCount: 60, headDrawn: 76 }))).toEqual([])
    expect(verifySnapshot(snapshot({ wall: undefined, wallCount: 60, headDrawn: 77 }))).toEqual([
      { code: 'WALL_PROGRESS', message: '牌墙进度不可能：headDrawn=77 + wallCount=60 > 136' },
    ])
  })

  it('wallCount 与 wall 长度不符 → 违规', () => {
    const violations = verifySnapshot(snapshot({ wallCount: 5 }))
    expect(violations.some((v) => v.code === 'WALL_COUNT')).toBe(true)
  })

  it('莲花麻将翻精前的 dealing 快照允许 136 张环墙', () => {
    expect(verifySnapshot(snapshot({
      rulesetId: 'lotus-legacy',
      phase: 'dealing',
      wall: undefined,
      wallCount: 136,
      headDrawn: 0,
      flipTile: null,
    }))).toEqual([])
  })

  it('莲花麻将翻精后仍限制为 134 张可摸牌墙', () => {
    const violations = verifySnapshot(snapshot({
      rulesetId: 'lotus-legacy',
      phase: 'dealing',
      wall: undefined,
      wallCount: 136,
      headDrawn: 0,
      flipTile: 'm1',
    }))
    expect(violations.map((violation) => violation.code)).toEqual([
      'WALL_COUNT_RANGE',
      'WALL_PROGRESS',
    ])
  })

  it('座位重复 → 违规', () => {
    const players = snapshot().players
    players[1] = { ...players[1], seat: 0 }
    const violations = verifySnapshot(snapshot({ players }))
    expect(violations.some((v) => v.code === 'DUP_SEAT')).toBe(true)
  })

  it('手牌半透明（混 null 与真实牌）→ 违规', () => {
    const players = snapshot().players
    players[0] = { ...players[0], hand: ['m1', null] }
    const violations = verifySnapshot(snapshot({ players }))
    expect(violations.some((v) => v.code === 'HAND_MIX')).toBe(true)
  })

  it('非结算阶段非目标座位的真实手牌 → 违规', () => {
    const players = snapshot().players
    players[1] = { ...players[1], hand: ['m2'] }
    const violations = verifySnapshot(snapshot({ players }))
    expect(violations.some((v) => v.code === 'HAND_LEAK')).toBe(true)
  })

  it('结算亮牌阶段允许各座位显示真实手牌', () => {
    const players = snapshot().players.map((player) => ({
      ...player,
      hand: player.hand.map((tile) => tile ?? 'm1'),
    }))
    expect(verifySnapshot(snapshot({ phase: 'revealing', players }))).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'HAND_LEAK' }),
    ]))
  })

  it('请求代次元数据不完整时拒绝快照', () => {
    const violations = verifySnapshot(snapshot({ authorityEpoch: 'epoch-1', sequence: 2, requestId: 'epoch-1:1', requestSeq: null }))
    expect(violations.map((item) => item.code)).toContain('REQUEST_META_MISMATCH')
  })

  it('拒绝非整数的权威状态坐标', () => {
    const violations = verifySnapshot(snapshot({
      round: 1.5,
      dealer: 0.5,
      wallCount: 3.25,
    }))
    expect(violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      'BAD_ROUND', 'BAD_DEALER', 'WALL_COUNT_RANGE',
    ]))
  })

  it('拒绝不完整的终局标志，终局必须由 phase 和 matchFinished 同时确认', () => {
    expect(verifySnapshot(snapshot({ phase: 'finished', matchFinished: false }))).toEqual(expect.arrayContaining([
      {
        code: 'TERMINAL_STATE_MISMATCH',
        message: '终局字段不一致：phase=finished, matchFinished=false',
      },
    ]))
    expect(verifySnapshot(snapshot({ phase: 'discard', matchFinished: true })).map((item) => item.code)).toContain('TERMINAL_STATE_MISMATCH')
    expect(verifySnapshot(snapshot({ phase: 'finished', matchFinished: true }))).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TERMINAL_STATE_MISMATCH' }),
    ]))
  })

  it('拒绝缺少结果的 settled 快照', () => {
    expect(verifySnapshot(snapshot({ phase: 'settled', result: null })).map((item) => item.code)).toContain('SETTLEMENT_RESULT_MISSING')
    expect(verifySnapshot(snapshot({
      phase: 'settled',
      result: { winnerIndex: 0 },
    })).map((item) => item.code)).not.toContain('SETTLEMENT_RESULT_MISSING')
  })
})
