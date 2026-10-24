import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostOpeningBarrier } from './openingBarrier'

describe('opening host-loading reproduction', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not start the next hand while the host table is still loading', async () => {
    const livePeers = ['client-peer']
    let hostTableReady = false
    let authorityEnteredTurn = false
    const barrier = createHostOpeningBarrier(() => livePeers, 60_000)

    // 模拟东二开局：客户端牌桌已完成，先发 opening_done；房主牌桌仍在加载。
    let settled = false
    const authorityStart = barrier.wait(2, 0).then(() => {
      settled = true
      authorityEnteredTurn = true
    })
    barrier.markPeerReady('client-peer', 2, 0)
    await Promise.resolve()
    expect(authorityEnteredTurn).toBe(false)
    expect(hostTableReady).toBe(false)

    // 即使经过原来的 60s 兜底期限，权威引擎也不能先于房主 viewer 进入首回合。
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(authorityEnteredTurn).toBe(false)
    expect(hostTableReady).toBe(false)

    // 房主牌桌真正完成开场后，屏障才允许权威引擎继续。
    hostTableReady = true
    barrier.markLocalReady(2, 0)
    await authorityStart
    expect(authorityEnteredTurn).toBe(true)
  })
})
