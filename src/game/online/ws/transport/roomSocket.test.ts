import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoomSocketTransport, type SocketLike } from './roomSocket'

class MockSocket implements SocketLike {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('roomSocket', () => {
  it('opens, parses incoming messages and sends client actions', () => {
    const sockets: MockSocket[] = []
    const messages: unknown[] = []
    const transport = createRoomSocketTransport({
      getUrl: () => 'ws://server/ws/room/A',
      onMessage: (message) => messages.push(message),
      socketFactory: () => {
        const socket = new MockSocket()
        sockets.push(socket)
        return socket
      },
    })

    transport.open()
    expect(transport.status.value).toBe('connecting')
    sockets[0].open()
    expect(transport.status.value).toBe('connected')

    sockets[0].receive({ kind: 'state_snapshot', round: 1 })
    expect(messages).toEqual([{ kind: 'state_snapshot', round: 1 }])
    expect(transport.send({ type: 'discard', handIndex: 4 })).toBe(true)
    expect(sockets[0].sent).toContain(JSON.stringify({ type: 'discard', handIndex: 4 }))
  })

  it('owns ping, pong RTT and signal quality calculation', async () => {
    const socket = new MockSocket()
    const transport = createRoomSocketTransport({
      getUrl: () => 'ws://server/ws/room/A',
      onMessage: () => {},
      socketFactory: () => socket,
    })

    transport.open()
    socket.open()
    await vi.advanceTimersByTimeAsync(5000)
    expect(socket.sent.at(-1)).toContain('"ping"')
    socket.receive({ kind: 'pong' })
    expect(transport.signalQuality.value).toBe(3)
  })

  it('detects a stalled connection and reconnects with backoff', async () => {
    const sockets: MockSocket[] = []
    const transport = createRoomSocketTransport({
      getUrl: () => 'ws://server/ws/room/A',
      onMessage: () => {},
      socketFactory: () => {
        const socket = new MockSocket()
        sockets.push(socket)
        return socket
      },
    })

    transport.open()
    sockets[0].open()
    await vi.advanceTimersByTimeAsync(16000)
    expect(transport.status.value).toBe('reconnecting')
    expect(transport.signalQuality.value).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)
    expect(transport.status.value).toBe('connecting')
  })

  it('cancels reconnect and timers when intentionally closed', async () => {
    const sockets: MockSocket[] = []
    const transport = createRoomSocketTransport({
      getUrl: () => 'ws://server/ws/room/A',
      onMessage: () => {},
      socketFactory: () => {
        const socket = new MockSocket()
        sockets.push(socket)
        return socket
      },
    })

    transport.open()
    sockets[0].open()
    sockets[0].close()
    expect(transport.status.value).toBe('reconnecting')
    transport.close()
    await vi.advanceTimersByTimeAsync(10000)

    expect(transport.status.value).toBe('idle')
    expect(sockets).toHaveLength(1)
  })
})
