import { describe, expect, it, vi } from 'vitest'
import {
  createServerMessageRouter,
  type ServerMessageHandlers,
  type ServerMessageKind,
} from './serverMessageRouter'
import type { ServerMessage } from '../protocol/messages'

const MESSAGE_KINDS: ServerMessageKind[] = [
  'state_snapshot', 'turn_request', 'claim_request', 'rob_kong_request',
  'round_start', 'win_effect', 'round_settled', 'rejoin_ok', 'rejoin_err', 'table_action', 'score_flow',
  'announcement', 'hand_result', 'continue_prompt', 'match_finished',
  'room_closed', 'pong', 'error',
]

const player = {
  name: 'A', avatar: '', score: 1000, seat: 0,
  hand: ['m1'] as const, discards: [] as const, melds: [] as const,
  redCount: 0, drawnTileIndex: -1,
}
const VALID_MESSAGES: ServerMessage[] = [
  {
    kind: 'state_snapshot', roomId: 'ROOM', authorityEpoch: 'epoch-1', sequence: 1,
    requestId: null, requestSeq: null, mode: 'east', phase: 'playing', round: 1,
    dealer: 0, honba: 0, wallCount: 1, wall: ['m2'], headDrawn: 0,
    // lotus-classic 无翻精时后端发送 null；decoder 用 isNullable 校验。
    flipTile: null, flipStack: null, openingStack: null,
    currentPlayer: 0, players: [{ ...player, hand: [...player.hand], discards: [], melds: [] }],
    seat: 0, result: null, announcement: null, matchFinished: false,
    lastDiscard: null, winPresentation: null, winningPlayerIndex: -1,
  },
  { kind: 'turn_request', authorityEpoch: 'epoch-1', round: 1, requestId: 'epoch-1:1', requestSeq: 1, targetSeat: 1, ctx: { hand: ['m1'], melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false } },
  { kind: 'claim_request', authorityEpoch: 'epoch-1', round: 1, requestId: 'epoch-1:2', requestSeq: 2, targetSeat: 1, ctx: { hand: ['m1'], canGang: false, tile: 'm2', from: 1 } },
  { kind: 'rob_kong_request', authorityEpoch: 'epoch-1', round: 1, requestId: 'epoch-1:3', requestSeq: 3, targetSeat: 1, ctx: { tile: 'm2', from: 1, hand: ['m1'], exposedMelds: 0 } },
  { kind: 'round_start', roomId: 'ROOM', authorityEpoch: 'epoch-1', sequence: 1, matchStarted: true, round: 1, dealer: 0, honba: 0, dice: [2, 5] },
  {
    kind: 'win_effect', roomId: 'ROOM', authorityEpoch: 'epoch-1', sequence: 1,
    round: 1, honba: 0, winningPlayerIndex: 0,
    winPresentation: {
      winnerIndex: 0, tile: 'm1', sourceIndex: -1, robbedKong: false,
      robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1,
    },
  },
  {
    kind: 'round_settled', roomId: 'ROOM', authorityEpoch: 'epoch-1', sequence: 2,
    mode: 'east', round: 1, honba: 0, dealer: 0, result: { winnerIndex: 0 },
    winPresentation: null, winningPlayerIndex: 0,
    players: [0, 1, 2, 3].map((seat) => ({
      ...player, name: `P${seat}`, seat, hand: [...player.hand], discards: [], melds: [],
    })),
    scores: [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, score: 1000 })),
  },
  { kind: 'rejoin_ok', authorityEpoch: 'epoch-1', seat: 0, rejoin: false, roomId: 'ROOM', mode: 'east', nickname: 'A', rejoinCode: 'CODE' },
  { kind: 'rejoin_err', code: 'NOT_FOUND' },
  { kind: 'table_action', authorityEpoch: 'epoch-1', round: 1, event: { id: 1, type: 'peng', actorIndex: 0, sourceIndex: 1, tile: 'm1', meldIndex: 0 } },
  { kind: 'score_flow', authorityEpoch: 'epoch-1', round: 1, deltas: [{ playerIndex: 0, amount: 10 }] },
  { kind: 'announcement', authorityEpoch: 'epoch-1', round: 1, text: '碰', tone: 'gold', id: 1 },
  { kind: 'hand_result', authorityEpoch: 'epoch-1', round: 1, result: { winnerIndex: 0 } },
  { kind: 'continue_prompt', total: 4 },
  { kind: 'match_finished', roomId: 'ROOM', mode: 'east', authorityEpoch: 'epoch-1', sequence: 2, round: 4, finalScores: [{ seat: 0, name: 'A', score: 1000 }] },
  { kind: 'room_closed' },
  { kind: 'pong' },
  { kind: 'error', code: 'BAD_REQUEST' },
]

describe('serverMessageRouter', () => {
  it('把每一种协议消息精确分发到同名处理器', () => {
    const spies = Object.fromEntries(
      MESSAGE_KINDS.map((kind) => [kind, vi.fn()]),
    ) as unknown as ServerMessageHandlers
    const route = createServerMessageRouter(spies)

    VALID_MESSAGES.forEach((message) => {
      const kind = message.kind
      expect(route(message)).toBe(true)
      expect(spies[kind]).toHaveBeenCalledWith(message)
    })
  })

  it('忽略空值、无 kind 和未知消息，不误调用处理器', () => {
    const fallback = vi.fn()
    const handlers = Object.fromEntries(
      MESSAGE_KINDS.map((kind) => [kind, fallback]),
    ) as unknown as ServerMessageHandlers
    const route = createServerMessageRouter(handlers)

    expect(route(null)).toBe(false)
    expect(route({})).toBe(false)
    expect(route({ kind: 'future_message' })).toBe(false)
    expect(route({ kind: 'continue_prompt', total: '4' })).toBe(false)
    expect(route({ kind: 'turn_request', ctx: { hand: ['not-a-tile'] } })).toBe(false)
    expect(fallback).not.toHaveBeenCalled()
  })
})
