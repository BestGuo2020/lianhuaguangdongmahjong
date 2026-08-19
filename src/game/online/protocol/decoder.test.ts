import { describe, expect, it } from 'vitest'
import { decodeServerMessage } from './decoder'

describe('decodeServerMessage', () => {
  it('accepts a structurally valid protocol message', () => {
    const message = { kind: 'announcement', authorityEpoch: 'epoch-1', round: 1, text: '杠', tone: 'gold', id: 7 }
    expect(decodeServerMessage(message)).toBe(message)
  })

  it('rejects malformed known messages instead of trusting their kind', () => {
    expect(decodeServerMessage({ kind: 'round_start', round: 1, dice: [2] })).toBeNull()
    expect(decodeServerMessage({ kind: 'score_flow', deltas: [{ playerIndex: 0, amount: '10' }] })).toBeNull()
    expect(decodeServerMessage({ kind: 'hand_result', result: { winTile: 'm10' } })).toBeNull()
  })

  it('拒绝缺少房主代次/序号的可改变牌局语义的消息', () => {
    const roundStart = {
      kind: 'round_start', matchStarted: true, round: 1, dealer: 0, honba: 0, dice: [2, 5],
    }
    const announcement = { kind: 'announcement', text: '碰', tone: 'gold', id: 1 }
    const snapshot = {
      kind: 'state_snapshot', roomId: 'ROOM01', mode: 'east', phase: 'playing',
      round: 1, dealer: 0, honba: 0, wallCount: 0, wall: [], headDrawn: 0,
      currentPlayer: -1, players: [], seat: 0, result: null, announcement: null,
      matchFinished: false, lastDiscard: null, winPresentation: null, winningPlayerIndex: -1,
    }
    expect(decodeServerMessage(roundStart)).toBeNull()
    expect(decodeServerMessage(announcement)).toBeNull()
    expect(decodeServerMessage(snapshot)).toBeNull()
  })

  it('accepts an optional second dice pair on round_start', () => {
    const message = {
      kind: 'round_start', roomId: 'ROOM01', authorityEpoch: 'epoch-1', sequence: 1,
      matchStarted: true, round: 1, dealer: 0, honba: 0, dice: [2, 5], secondDice: [4, 6],
    }
    expect(decodeServerMessage(message)).toBe(message)
    expect(decodeServerMessage({ ...message, secondDice: [4] })).toBeNull()
  })

  it('accepts optional authoritative lotus flip metadata', () => {
    const message = {
      kind: 'round_start', roomId: 'ROOM01', authorityEpoch: 'epoch-1', sequence: 1,
      matchStarted: true, round: 1, dealer: 0, honba: 0,
      dice: [2, 5], secondDice: [4, 6], flipTile: 'm1', flipStack: 4, flipSeat: 1,
    }
    expect(decodeServerMessage(message)).toBe(message)
    expect(decodeServerMessage({ ...message, flipTile: 'm10' })).toBeNull()
  })

  it('只接受带完整权威边界和四席分数的公共结算事实', () => {
    const message = {
      kind: 'round_settled', roomId: 'ROOM01', authorityEpoch: 'epoch-1', sequence: 7,
      mode: 'east', rulesetId: 'lotus-legacy', round: 2, honba: 0, dealer: 1,
      result: { winnerIndex: 3, winTile: 'm9' },
      winPresentation: null, winningPlayerIndex: 3,
      scores: [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, score: 2000 })),
    }
    expect(decodeServerMessage(message)).toBe(message)
    expect(decodeServerMessage({ ...message, sequence: 0 })).toBeNull()
    expect(decodeServerMessage({ ...message, scores: message.scores.slice(0, 3) })).toBeNull()
    expect(decodeServerMessage({ ...message, scores: message.scores.map((entry) => ({ ...entry, seat: 0 })) })).toBeNull()
  })

  it('只接受带完整权威边界的公共胡牌特效事件', () => {
    const message = {
      kind: 'win_effect', roomId: 'ROOM01', authorityEpoch: 'epoch-1', sequence: 3,
      round: 2, honba: 0, winningPlayerIndex: 3,
      winPresentation: {
        winnerIndex: 3, tile: 'm9', sourceIndex: -1, robbedKong: false,
        robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1,
      },
    }
    expect(decodeServerMessage(message)).toBe(message)
    expect(decodeServerMessage({ ...message, sequence: 0 })).toBeNull()
    expect(decodeServerMessage({ ...message, roomId: 123 })).toBeNull()
    expect(decodeServerMessage({ ...message, winningPlayerIndex: 4 })).toBeNull()
    expect(decodeServerMessage({ ...message, winPresentation: { ...message.winPresentation, tile: 'm10' } })).toBeNull()
    // sourceIndex 是赢家手牌内索引（自摸 drawnTileIndex / 点炮 lastIndexOf(winTile)），
    // 合法范围可到 13+，不是座位。曾误限制在 [-1,3]，胡牌在手牌位置 >=4 时整条
    // win_effect/round_settled/快照解码失败，客户端永远进不了结算。
    expect(decodeServerMessage({ ...message, winPresentation: { ...message.winPresentation, sourceIndex: 4 } })).not.toBeNull()
    expect(decodeServerMessage({ ...message, winPresentation: { ...message.winPresentation, sourceIndex: 13 } })).not.toBeNull()
    expect(decodeServerMessage({ ...message, winPresentation: { ...message.winPresentation, sourceIndex: 21 } })).toBeNull()
    expect(decodeServerMessage({ ...message, winPresentation: { ...message.winPresentation, sourceIndex: 1.5 } })).toBeNull()
  })

  it('rejects unknown kinds and non-object input', () => {
    expect(decodeServerMessage({ kind: 'future_message' })).toBeNull()
    expect(decodeServerMessage('{"kind":"pong"}')).toBeNull()
  })

  it('rejects zero or fractional authority counters', () => {
    const request = {
      kind: 'turn_request', authorityEpoch: 'epoch-1', round: 1,
      requestId: 'epoch-1:1', requestSeq: 1, targetSeat: 1,
      ctx: {
        hand: ['m1'], melds: [], exposedMelds: 0,
        kongBloom: false, skipDraw: false, afterKong: false,
      },
    }
    expect(decodeServerMessage({ ...request, requestSeq: 0 })).toBeNull()
    expect(decodeServerMessage({ ...request, round: 0 })).toBeNull()
    expect(decodeServerMessage({ ...request, targetSeat: 1.5 })).toBeNull()
    expect(decodeServerMessage({ ...request, targetSeat: 4 })).toBeNull()
  })

  it('rejects impossible authoritative coordinates and dice values', () => {
    const roundStart = {
      kind: 'round_start', roomId: 'ROOM01', authorityEpoch: 'epoch-1', sequence: 1,
      matchStarted: true, round: 1, dealer: 0, honba: 0, dice: [2, 5],
    }
    expect(decodeServerMessage({ ...roundStart, dealer: 4 })).toBeNull()
    expect(decodeServerMessage({ ...roundStart, dice: [0, 7] })).toBeNull()

    const request = {
      kind: 'claim_request', authorityEpoch: 'epoch-1', round: 1,
      requestId: 'epoch-1:1', requestSeq: 1, targetSeat: 1,
      ctx: { hand: ['m1'], canGang: false, tile: 'm2', from: 2 },
    }
    expect(decodeServerMessage({ ...request, ctx: { ...request.ctx, from: 4 } })).toBeNull()

    const tableAction = {
      kind: 'table_action', authorityEpoch: 'epoch-1', round: 1,
      event: { id: 1, type: 'peng', actorIndex: 1, sourceIndex: 2, tile: 'm1', meldIndex: 0 },
    }
    expect(decodeServerMessage({ ...tableAction, event: { ...tableAction.event, actorIndex: 1.5 } })).toBeNull()
    expect(decodeServerMessage({ ...tableAction, event: { ...tableAction.event, meldIndex: 4 } })).toBeNull()
  })

  it('accepts nullable optional meld fields emitted by the backend snapshot serializer', () => {
    const message = {
      kind: 'state_snapshot', roomId: 'ROOM01', authorityEpoch: 'epoch-1', sequence: 1,
      requestId: null, requestSeq: null, mode: 'east', phase: 'thinking',
      round: 1, dealer: 0, honba: 0, dice: [2, 5], wallCount: 80,
      wall: ['m1'], headDrawn: 52, currentPlayer: 0, seat: 0,
      // lotus-classic 无翻精时后端发送 null 而非省略；decoder 用 isNullable 校验。
      flipTile: null, flipStack: null, openingStack: null,
      players: [{
        name: 'P0', avatar: '', score: 1000, seat: 0, hand: [null], discards: [],
        melds: [{ type: 'flower', tile: 'red', tiles: ['red'], from: null, added: null, pending: null }],
        redCount: 1, drawnTileIndex: -1,
      }],
      result: null, announcement: null, matchFinished: false, lastDiscard: null,
      winPresentation: null, winningPlayerIndex: -1,
    }

    expect(decodeServerMessage(message)).toBe(message)
  })

  it('validates optional opening metadata on snapshots', () => {
    const message = {
      kind: 'state_snapshot', roomId: 'ROOM01', authorityEpoch: 'epoch-1', sequence: 1,
      requestId: null, requestSeq: null, mode: 'east', phase: 'dealing',
      round: 1, dealer: 0, honba: 0, dice: [2, 5], secondDice: [4, 6],
      flipTile: 'm1', jokerTiles: ['m1', 'm2'], wildcardTiles: ['white'],
      flipStack: 4, openingStack: 18, wallBreakIndex: 36, wallCount: 134,
      wall: ['m1'], headDrawn: 0, currentPlayer: -1, seat: 0,
      players: [], result: null, announcement: null, matchFinished: false,
      lastDiscard: null, winPresentation: null, winningPlayerIndex: -1,
    }
    expect(decodeServerMessage(message)).toBe(message)
    expect(decodeServerMessage({ ...message, wallBreakIndex: '36' })).toBeNull()
    expect(decodeServerMessage({ ...message, jokerTiles: ['m10'] })).toBeNull()
  })

  it('rejects a snapshot with only one terminal flag', () => {
    const message = {
      kind: 'state_snapshot', roomId: 'ROOM01', authorityEpoch: 'epoch-1', sequence: 1,
      requestId: null, requestSeq: null, mode: 'east', phase: 'finished',
      round: 4, dealer: 0, honba: 0, dice: [2, 5], wallCount: 0,
      wall: [], headDrawn: 136, currentPlayer: -1, seat: 0,
      players: [], result: null, announcement: null, matchFinished: false,
      lastDiscard: null, winPresentation: null, winningPlayerIndex: -1,
    }
    expect(decodeServerMessage(message)).toBeNull()
  })

  it('accepts null flip metadata on lotus-classic snapshots (no joker flip)', () => {
    // 莲花广麻（lotus-classic，默认规则）无翻精：后端快照中 flipTile / flipStack /
    // openingStack 发送 null 而非省略。此前用 isOptional（仅接受 undefined）校验，
    // null 会使整条 state_snapshot 解码失败 → 前端停留在房间面板，无法进入对局界面。
    const message = {
      kind: 'state_snapshot', roomId: 'ROOM01', authorityEpoch: 'epoch-1', sequence: 1,
      requestId: null, requestSeq: null, mode: 'east', rulesetId: 'lotus-classic',
      phase: 'opening', round: 1, dealer: 0, honba: 0, dice: [3, 6],
      secondDice: [1, 1], flipTile: null, jokerTiles: [], wildcardTiles: [],
      flipStack: null, openingStack: null, wallBreakIndex: 6, wallCount: 80,
      wall: ['white'], headDrawn: 52, currentPlayer: -1, seat: 0,
      players: [{
        name: 'P0', avatar: '', score: 2000, seat: 0, hand: ['m1'], discards: [],
        melds: [], redCount: 0, drawnTileIndex: -1,
      }],
      result: null, announcement: null, matchFinished: false, lastDiscard: null,
      winPresentation: null, winningPlayerIndex: -1,
    }
    expect(decodeServerMessage(message)).toBe(message)
    expect(decodeServerMessage({ ...message, flipTile: 'm10' })).toBeNull()
    expect(decodeServerMessage({ ...message, flipStack: '4' })).toBeNull()
  })
})
