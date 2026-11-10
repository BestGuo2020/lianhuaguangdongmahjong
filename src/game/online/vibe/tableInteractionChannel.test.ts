import { expect, it, vi } from 'vitest'
import { createVibeTableInteractionChannel } from './tableInteractionChannel'

function endpoint(peerId: string) {
  let onMessage: ((value: unknown, from: string) => void) | undefined
  const send = vi.fn()
  const room = {
    peerId, hostId: 'host', send,
    onMessage: (receive: typeof onMessage) => { onMessage = receive },
  } as unknown as VibeHubSDK.Room
  return { room, send, receive: (value: unknown, from: string) => onMessage?.(value, from) }
}

it('directs requests to the host and rejects forged peers, actions and old hands', () => {
  let scope = 'epoch:1:0'
  const host = endpoint('host')
  const guest = endpoint('guest')
  const hostEvent = vi.fn()
  const guestEvent = vi.fn()
  const shared = {
    getScope: () => scope,
    getPeerSeat: (peer: string) => peer === 'guest' ? 2 : undefined,
    acceptHost: (_room: VibeHubSDK.Room, peer: string) => peer === 'host',
  }
  const authority = createVibeTableInteractionChannel({
    ...shared, getRoom: () => host.room, getSeat: () => 0, isHost: () => true, onEvent: hostEvent,
  })
  const client = createVibeTableInteractionChannel({
    ...shared, getRoom: () => guest.room, getSeat: () => 2, isHost: () => false, onEvent: guestEvent,
  })
  authority.attach(host.room)
  client.attach(guest.room)
  const action = { type: 'emote', emote: 'like', targetSeat: 0 } as const
  expect(client.send(action)).toBe(true)
  const request = { kind: 'table_interaction_request', scope, action }
  expect(guest.send).toHaveBeenCalledExactlyOnceWith(request, 'host')
  host.receive(request, 'outsider')
  host.receive({ ...request, action: { ...action, targetSeat: 2 } }, 'guest')
  expect(hostEvent).not.toHaveBeenCalled()

  host.receive({ ...request, fromSeat: 3 }, 'guest')
  const event = { kind: 'table_interaction', scope, id: 1, fromSeat: 2, action }
  expect(host.send).toHaveBeenCalledExactlyOnceWith(event)
  expect(hostEvent).toHaveBeenCalledExactlyOnceWith(event)
  guest.receive(event, 'guest')
  expect(guestEvent).not.toHaveBeenCalled()
  guest.receive(event, 'host')
  expect(guestEvent).toHaveBeenCalledExactlyOnceWith(event)
  scope = 'epoch:2:0'
  guest.receive(event, 'host')
  host.receive(request, 'guest')
  expect(guestEvent).toHaveBeenCalledTimes(1)
  expect(hostEvent).toHaveBeenCalledTimes(1)
})
