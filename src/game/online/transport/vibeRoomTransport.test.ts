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

describe('vibeRoomTransport（SDK 事件驱动）', () => {
  it('读取 SDK 网络质量，不发送应用层心跳', () => {
    const room = createMockVibeRoom(false)
    const mutablePeers: VibeHubSDK.PeerInfo[] = [peer()]
    const originalPeers = room.peers
    room.peers = () => mutablePeers
    room.networkStats = () => ({ quality: { rttP95Ms: 400 } } as VibeHubSDK.NetworkStats)
    const transport = createVibeRoomTransport({
      getRoom: () => room,
      onMessage: () => {},
    })
    transport.open()
    expect(transport.signalQuality.value).toBe(1)
    expect(room.sent).toEqual([])

    transport.close()
    expect(transport.signalQuality.value).toBe(0)
    room.peers = originalPeers
  })

  it('SDK reconnecting 事件超时后升级完整重进，收到房主消息则取消', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(false)
    const onHostConnectionLost = vi.fn()
    const transport = createVibeRoomTransport({
      getRoom: () => room,
      onMessage: () => {},
      onHostConnectionLost,
    })
    transport.open()

    room.emitPeer({ type: 'reconnecting', id: 'host-peer' })
    vi.advanceTimersByTime(7000)
    expect(onHostConnectionLost).not.toHaveBeenCalled()
    room.emit('host-peer', { kind: 'state_snapshot' })
    expect(transport.status.value).toBe('connected')
    vi.advanceTimersByTime(2000)
    expect(onHostConnectionLost).not.toHaveBeenCalled()

    room.emitPeer({ type: 'reconnecting', id: 'host-peer' })
    vi.advanceTimersByTime(8000)
    expect(onHostConnectionLost).toHaveBeenCalledOnce()
    transport.close()
  })

  it('可靠业务发送遇到 closed-PC 异常立即升级完整房间重进', () => {
    const room = createMockVibeRoom(false)
    room.send = () => { throw new Error('RTCPeerConnection is closed') }
    const onHostConnectionLost = vi.fn()
    const transport = createVibeRoomTransport({
      getRoom: () => room,
      onMessage: () => {},
      onHostConnectionLost,
    })
    transport.open()

    expect(transport.send({ type: 'continue' })).toBe(false)
    expect(onHostConnectionLost).toHaveBeenCalledOnce()
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

  it('close 后 reopen 同一个 Room 不会激活旧监听器导致第二场重复处理', () => {
    const room = createMockVibeRoom(false)
    const received: unknown[] = []
    const transport = createVibeRoomTransport({
      getRoom: () => room,
      onMessage: (message) => received.push(message),
    })
    transport.open()
    transport.close()
    transport.open()

    room.emit('host-peer', { kind: 'second_match' })
    expect(received).toEqual([{ kind: 'second_match' }])
    transport.close()
  })
})
