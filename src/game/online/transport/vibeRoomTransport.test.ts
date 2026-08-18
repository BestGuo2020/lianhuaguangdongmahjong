import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVibeRoomTransport } from './vibeRoomTransport'
import { createMockVibeRoom } from '../host/mockVibeRoom'

function peer(overrides: Partial<VibeHubSDK.PeerInfo> = {}): VibeHubSDK.PeerInfo {
  return {
    id: 'p1', open: true, latency: 5, jitter: 0, relay: false, realtime: true, reconnecting: false,
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('vibeRoomTransport 信号检测（应用层 RTT ping-pong）', () => {
  it('基于真实往返 RTT 定信号：<150ms=3、300-500ms=1；无 pong 时按对端连接状态兜底', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(false)
    const mutablePeers: VibeHubSDK.PeerInfo[] = [peer()]
    const originalPeers = room.peers
    // mockVibeRoom.peers 固定返回 []：覆写为可变的对端列表。
    room.peers = () => mutablePeers
    const transport = createVibeRoomTransport({
      getRoom: () => room,
      onMessage: () => {},
      signalIntervalMs: 3000,
    })
    transport.open()
    expect(transport.signalQuality.value).toBe(3) // 对端正常且无 RTT 数据 → 流畅

    // 第一个 tick（interval 3s，tick 在 3000ms 触发）发出心跳 ping。
    vi.advanceTimersByTime(3100)
    const ping = room.sent.find((s) => (s.message as { __transport_ping?: number })?.__transport_ping != null)
    expect(ping).toBeTruthy()
    // 对端几乎立即回 pong → RTT ≈ 100ms → 3 格。
    room.emit('peer1', { __transport_pong: (ping!.message as { __transport_ping: number }).__transport_ping })
    expect(transport.signalQuality.value).toBe(3)

    // 第二个 tick（tick 在 6000ms 触发）：对端延迟 400ms 才回 pong → RTT=400 → 1 格（波动）。
    vi.advanceTimersByTime(3100)
    const ping2 = room.sent.filter((s) => (s.message as { __transport_ping?: number })?.__transport_ping != null).at(-1)!
    vi.advanceTimersByTime(200) // 6200 + 200 = 6400 → RTT = 6400 - 6000 = 400
    room.emit('peer1', { __transport_pong: (ping2.message as { __transport_ping: number }).__transport_ping })
    expect(transport.signalQuality.value).toBe(1)

    // 对端 reconnecting（直连在重连）→ 兜底 1 格（即使 RTT 低）。
    mutablePeers[0] = peer({ reconnecting: true })
    vi.advanceTimersByTime(3100)
    expect(transport.signalQuality.value).toBe(1)

    // 无对端（大厅空房）→ 默认良好 3。
    mutablePeers.splice(0)
    vi.advanceTimersByTime(3100)
    expect(transport.signalQuality.value).toBe(3)

    transport.close()
    expect(transport.signalQuality.value).toBe(0)
    room.peers = originalPeers
  })

  it('收到对端 ping 立即回 pong（心跳应答）', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(false)
    const transport = createVibeRoomTransport({ getRoom: () => room, onMessage: () => {} })
    transport.open()
    room.sent.splice(0)
    room.emit('peer1', { __transport_ping: 12345 })
    expect(room.sent.some((s) => (s.message as { __transport_pong?: number })?.__transport_pong === 12345)).toBe(true)
    transport.close()
  })

  it('P2P 切换 relay 后恢复为 connected，不显示断线', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(false)
    room.peers = () => [peer({ reconnecting: true, relay: true, open: true })]
    const transport = createVibeRoomTransport({ getRoom: () => room, onMessage: () => {} })
    transport.open()

    room.emitPeer({ type: 'reconnecting', id: 'host-peer' })
    vi.advanceTimersByTime(2100)
    expect(transport.status.value).toBe('reconnecting')

    room.emitPeer({ type: 'relay', id: 'host-peer', active: true })
    expect(transport.status.value).toBe('connected')
    transport.close()
  })

  it('刷新重进后忽略旧 Room 迟到的消息和 peer 事件', () => {
    const oldRoom = createMockVibeRoom(false)
    const newRoom = createMockVibeRoom(false)
    let currentRoom: VibeHubSDK.Room = oldRoom
    const received: unknown[] = []
    const transport = createVibeRoomTransport({
      getRoom: () => currentRoom,
      onMessage: (message) => received.push(message),
    })
    transport.open()
    transport.close()
    currentRoom = newRoom
    transport.open()

    oldRoom.emit('host-peer', { kind: 'stale_old_room' })
    oldRoom.emitPeer({ type: 'reconnecting', id: 'host-peer' })
    expect(received).toEqual([])

    newRoom.emit('host-peer', { kind: 'current_room' })
    expect(received).toEqual([{ kind: 'current_room' }])
    transport.close()
  })
})
