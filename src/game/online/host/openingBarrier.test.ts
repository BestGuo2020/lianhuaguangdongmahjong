import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostOpeningBarrier } from './openingBarrier'

describe('hostOpeningBarrier', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for the host and every live peer', async () => {
    let peers = ['peer-a', 'peer-b']
    const barrier = createHostOpeningBarrier(() => peers, 1000)
    const ready = barrier.wait(3, 1)

    barrier.markLocalReady(3, 1)
    barrier.markPeerReady('peer-a', 3, 1)
    let done = false
    void ready.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)

    barrier.markPeerReady('peer-b', 2, 1)
    expect(done).toBe(false)
    barrier.markPeerReady('peer-b', 3, 0)
    expect(done).toBe(false)
    barrier.markPeerReady('peer-b', 3, 1)
    await ready
    expect(done).toBe(true)
  })

  it('releases disconnected peers and ignores stale confirmations', async () => {
    let peers = ['peer-a']
    const barrier = createHostOpeningBarrier(() => peers, 1000)
    const ready = barrier.wait(4, 0)
    barrier.markLocalReady(4, 0)
    barrier.markPeerReady('peer-a', 3, 0)
    peers = []
    barrier.removePeer('peer-a')
    await ready
  })

  it('does not release the engine when the host table is still loading', async () => {
    const barrier = createHostOpeningBarrier(() => [], 1000)
    const ready = barrier.wait(1, 0)
    await vi.advanceTimersByTimeAsync(1000)
    let done = false
    void ready.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)

    barrier.markLocalReady(1, 0)
    await ready
  })
})
