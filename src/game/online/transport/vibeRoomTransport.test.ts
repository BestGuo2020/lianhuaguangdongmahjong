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

describe('vibeRoomTransport 信号检测', () => {
  it('按最差对端计算 0-3 格信号（直连低延迟=3；relay 高延迟=1；重连中=0）', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(false)
    const mutablePeers: VibeHubSDK.PeerInfo[] = [peer()]
    const originalPeers = room.peers
    // mockVibeRoom.peers 固定返回 []：覆写为可变的对端列表以测信号计算。
    room.peers = () => mutablePeers
    const transport = createVibeRoomTransport({
      getRoom: () => room,
      onMessage: () => {},
      signalIntervalMs: 1000,
    })
    transport.open()
    expect(transport.signalQuality.value).toBe(3)

    // 对端走 relay、延迟 400ms → 1 格。
    mutablePeers[0] = peer({ relay: true, latency: 400 })
    vi.advanceTimersByTime(1100)
    expect(transport.signalQuality.value).toBe(1)

    // 对端 reconnecting → 0 格。
    mutablePeers[0] = peer({ reconnecting: true })
    vi.advanceTimersByTime(1100)
    expect(transport.signalQuality.value).toBe(0)

    // 两个对端取最差：一个流畅（3）、一个 relay 抖动（1）→ 整体 1。
    mutablePeers[0] = peer({ latency: 5 })
    mutablePeers.push(peer({ id: 'p2', relay: true, latency: 80, jitter: 150 }))
    vi.advanceTimersByTime(1100)
    expect(transport.signalQuality.value).toBe(1)

    // 无对端（大厅空房）→ 默认良好 3，不误报「网络不稳定」。
    mutablePeers.splice(0)
    vi.advanceTimersByTime(1100)
    expect(transport.signalQuality.value).toBe(3)

    transport.close()
    expect(transport.signalQuality.value).toBe(0)
    // 还原 mock 的 peers（避免影响同文件其他用例）。
    room.peers = originalPeers
  })
})
