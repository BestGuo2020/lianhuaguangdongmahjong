import { describe, expect, it, vi } from 'vitest'
import {
  createServerMessageRouter,
  type ServerMessageHandlers,
  type ServerMessageKind,
} from './serverMessageRouter'

const MESSAGE_KINDS: ServerMessageKind[] = [
  'state_snapshot', 'turn_request', 'claim_request', 'rob_kong_request',
  'round_start', 'rejoin_ok', 'rejoin_err', 'table_action', 'score_flow',
  'announcement', 'hand_result', 'continue_prompt', 'match_finished',
  'room_closed', 'pong', 'error',
]

describe('serverMessageRouter', () => {
  it('把每一种协议消息精确分发到同名处理器', () => {
    const spies = Object.fromEntries(
      MESSAGE_KINDS.map((kind) => [kind, vi.fn()]),
    ) as unknown as ServerMessageHandlers
    const route = createServerMessageRouter(spies)

    MESSAGE_KINDS.forEach((kind) => {
      const message = { kind, marker: kind }
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
    expect(fallback).not.toHaveBeenCalled()
  })
})
