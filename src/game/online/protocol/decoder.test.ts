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

  it('rejects unknown kinds and non-object input', () => {
    expect(decodeServerMessage({ kind: 'future_message' })).toBeNull()
    expect(decodeServerMessage('{"kind":"pong"}')).toBeNull()
  })

  it('accepts nullable optional meld fields emitted by the backend snapshot serializer', () => {
    const message = {
      kind: 'state_snapshot', roomId: 'ROOM01', mode: 'east', phase: 'thinking',
      round: 1, dealer: 0, honba: 0, dice: [2, 5], wallCount: 80,
      wall: ['m1'], headDrawn: 52, currentPlayer: 0, seat: 0,
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
})
