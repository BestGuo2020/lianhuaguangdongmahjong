import { describe, expect, it } from 'vitest'
import { decodeServerMessage } from './decoder'

describe('decodeServerMessage', () => {
  it('accepts a structurally valid protocol message', () => {
    const message = { kind: 'announcement', text: '杠', tone: 'gold', id: 7 }
    expect(decodeServerMessage(message)).toBe(message)
  })

  it('rejects malformed known messages instead of trusting their kind', () => {
    expect(decodeServerMessage({ kind: 'round_start', round: 1, dice: [2] })).toBeNull()
    expect(decodeServerMessage({ kind: 'score_flow', deltas: [{ playerIndex: 0, amount: '10' }] })).toBeNull()
    expect(decodeServerMessage({ kind: 'hand_result', result: { winTile: 'm10' } })).toBeNull()
  })

  it('accepts bounded LLM bubble messages and rejects malformed seats/text', () => {
    const message = {
      kind: 'llm_message', seat: 2, text: '这一手稳住。', id: 7, priority: 'important',
      purpose: 'action', actionKind: 'peng', speechSource: 'model-message',
    }
    expect(decodeServerMessage(message)).toEqual(message)
    expect(decodeServerMessage({ ...message, seat: 4 })).toBeNull()
    expect(decodeServerMessage({ ...message, text: '' })).toBeNull()
    expect(decodeServerMessage({ ...message, priority: 'urgent' })).toBeNull()
    expect(decodeServerMessage({ ...message, purpose: 'unknown' })).toBeNull()
    expect(decodeServerMessage({ ...message, actionKind: '../peng' })).toBeNull()
    expect(decodeServerMessage({ ...message, speechSource: 'free-form' })).toBeNull()
  })

  it('accepts LLM reasoning status without carrying thought content', () => {
    expect(decodeServerMessage({ kind: 'llm_status', seat: 2, active: true, text: '让我想想怎么打。' }))
      .toEqual({ kind: 'llm_status', seat: 2, active: true, text: '让我想想怎么打。' })
    expect(decodeServerMessage({ kind: 'llm_status', seat: 4, active: true })).toBeNull()
    expect(decodeServerMessage({ kind: 'llm_status', seat: 2, active: 'yes' })).toBeNull()
    expect(decodeServerMessage({ kind: 'llm_status', seat: 2, active: true, text: '' })).toBeNull()
  })

  it('accepts hashed TTS audio URLs and rejects arbitrary remote URLs', () => {
    const message = {
      kind: 'llm_audio', messageId: 7, seat: 2,
      audioUrl: `/api/tts/audio/${'a'.repeat(64)}.mp3`, cached: true, priority: 'important',
      purpose: 'round-reaction', speechSource: 'model-message',
    }
    expect(decodeServerMessage(message)).toEqual(message)
    expect(decodeServerMessage({ ...message, audioUrl: 'https://evil.example/a.mp3' })).toBeNull()
    expect(decodeServerMessage({ ...message, priority: 'urgent' })).toBeNull()
    expect(decodeServerMessage({ ...message, purpose: 'unknown' })).toBeNull()
  })

  it('accepts an optional second dice pair on round_start', () => {
    const message = { kind: 'round_start', matchStarted: true, round: 1, dealer: 0, honba: 0, dice: [2, 5], secondDice: [4, 6] }
    expect(decodeServerMessage(message)).toBe(message)
    expect(decodeServerMessage({ ...message, secondDice: [4] })).toBeNull()
  })

  it('accepts optional authoritative lotus flip metadata', () => {
    const message = {
      kind: 'round_start', matchStarted: true, round: 1, dealer: 0, honba: 0,
      dice: [2, 5], secondDice: [4, 6], flipTile: 'm1', flipStack: 4, flipSeat: 1,
    }
    expect(decodeServerMessage(message)).toBe(message)
    expect(decodeServerMessage({ ...message, flipTile: 'm10' })).toBeNull()
  })

  it('rejects unknown kinds and non-object input', () => {
    expect(decodeServerMessage({ kind: 'future_message' })).toBeNull()
    expect(decodeServerMessage('{"kind":"pong"}')).toBeNull()
  })

  it('accepts nullable optional meld fields emitted by the backend snapshot serializer', () => {
    const message = {
      kind: 'state_snapshot', roomId: 'ROOM01', mode: 'east', phase: 'thinking',
      round: 1, dealer: 0, honba: 0, dice: [2, 5], wallCount: 80,
      wall: ['m1'], headDrawn: 52, currentPlayer: 0, seat: 0,
      // lotus-classic 无翻精时后端发送 null 而非省略；decoder 用 isNullable 校验。
      flipTile: null, flipStack: null, openingStack: null,
      players: [{
        name: 'P0', avatar: '', isLlm: true, score: 1000, seat: 0, hand: [null], discards: [],
        melds: [{ type: 'flower', tile: 'red', tiles: ['red'], from: null, added: null, pending: null }],
        redCount: 1, drawnTileIndex: -1,
      }],
      result: null, announcement: null, matchFinished: false, lastDiscard: null,
      winPresentation: null, winningPlayerIndex: -1,
    }

    expect(decodeServerMessage(message)).toBe(message)
    expect(decodeServerMessage({
      ...message,
      players: [{ ...message.players[0], isLlm: 'yes' }],
    })).toBeNull()
  })

  it('validates optional opening metadata on snapshots', () => {
    const message = {
      kind: 'state_snapshot', roomId: 'ROOM01', mode: 'east', phase: 'dealing',
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

  it('accepts null flip metadata on lotus-classic snapshots (no joker flip)', () => {
    // 莲花广麻（lotus-classic，默认规则）无翻精：后端快照中 flipTile / flipStack /
    // openingStack 发送 null 而非省略。此前用 isOptional（仅接受 undefined）校验，
    // null 会使整条 state_snapshot 解码失败 → 前端停留在房间面板，无法进入对局界面。
    const message = {
      kind: 'state_snapshot', roomId: 'ROOM01', mode: 'east', rulesetId: 'lotus-classic',
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

  it('treats winPresentation.sourceIndex as a hand-tile index, not a seat', () => {
    // sourceIndex 是赢家手牌内索引（自摸 drawnTileIndex / 点炮 lastIndexOf(winTile)），
    // 合法范围可到 13+；曾误限制为座位 [-1,3]，胡牌在手牌位置 >= 4 时整条快照解码失败。
    const base = {
      kind: 'state_snapshot', roomId: 'ROOM01', mode: 'east', phase: 'thinking',
      round: 1, dealer: 0, honba: 0, dice: [2, 5], wallCount: 80,
      wall: ['m1'], headDrawn: 52, currentPlayer: 0, seat: 0,
      flipTile: null, flipStack: null, openingStack: null,
      players: [], result: null, announcement: null, matchFinished: false,
      lastDiscard: null, winningPlayerIndex: -1,
    }
    const winning = {
      winnerIndex: 0, tile: 'm1', sourceIndex: 4, robbedKong: false,
      robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1,
    }
    expect(decodeServerMessage({ ...base, winPresentation: { ...winning, sourceIndex: 13 } })).toBeTruthy()
    expect(decodeServerMessage({ ...base, winPresentation: winning })).toBeTruthy()
    expect(decodeServerMessage({ ...base, winPresentation: { ...winning, sourceIndex: 21 } })).toBeNull()
    expect(decodeServerMessage({ ...base, winPresentation: { ...winning, sourceIndex: 1.5 } })).toBeNull()
  })

  it('rejects a snapshot with only one terminal flag', () => {
    const base = {
      kind: 'state_snapshot', roomId: 'ROOM01', mode: 'east', phase: 'finished',
      round: 4, dealer: 0, honba: 0, dice: [2, 5], wallCount: 0,
      wall: [], headDrawn: 136, currentPlayer: -1, seat: 0,
      flipTile: null, flipStack: null, openingStack: null,
      players: [], result: null, announcement: null, matchFinished: false,
      lastDiscard: null, winPresentation: null, winningPlayerIndex: -1,
    }
    expect(decodeServerMessage(base)).toBeNull()
    expect(decodeServerMessage({ ...base, matchFinished: true })).toBeTruthy()
    expect(decodeServerMessage({ ...base, phase: 'playing', matchFinished: true })).toBeNull()
  })
})
