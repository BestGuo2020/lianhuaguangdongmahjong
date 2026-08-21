import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostOpeningBarrier } from './openingBarrier'

describe('opening host-loading reproduction', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('client can finish opening while host table is still loading, then host timeout starts the next hand', async () => {
    const livePeers = ['client-peer']
    let hostTableReady = false
    let authorityEnteredTurn = false
    const barrier = createHostOpeningBarrier(() => livePeers, 60_000)

    // 模拟东二开局：客户端牌桌已完成，先发 opening_done；房主牌桌仍在加载。
    const authorityStart = barrier.wait(2, 0).then(() => { authorityEnteredTurn = true })
    barrier.markPeerReady('client-peer', 2, 0)
    await Promise.resolve()
    expect(authorityEnteredTurn).toBe(false)
    expect(hostTableReady).toBe(false)

    // 当前实现的 60s 兜底到期后，权威引擎会继续，即使房主 viewer 仍未 ready。
    await vi.advanceTimersByTimeAsync(60_000)
    await authorityStart
    expect(authorityEnteredTurn).toBe(true)
    expect(hostTableReady).toBe(false)
  })
})
