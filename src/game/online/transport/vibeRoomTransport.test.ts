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
  it('按最差对端计算 0-3 格信号（延迟/抖动主导；relay 不降档）', () => {
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

    // 对端走 relay、延迟 400ms → 2 格（只降一档；relay 下 SDK 延迟字段常虚高，
    // 实际打牌不卡，过度降档会误报「网络不稳定」）。
    mutablePeers[0] = peer({ relay: true, latency: 400 })
    vi.advanceTimersByTime(1100)
    expect(transport.signalQuality.value).toBe(2)

    // 对端 reconnecting（直连在重连，但 relay 通道通常仍可用）→ 1 格，不误报断线。
    mutablePeers[0] = peer({ reconnecting: true })
    vi.advanceTimersByTime(1100)
    expect(transport.signalQuality.value).toBe(1)

    // relay 但低延迟 → 不降档（3）；抖动 >100 才降。两个对端取最差。
    mutablePeers[0] = peer({ relay: true, latency: 5 })
    mutablePeers.push(peer({ id: 'p2', latency: 5, jitter: 150 }))
    vi.advanceTimersByTime(1100)
    expect(transport.signalQuality.value).toBe(2)

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
