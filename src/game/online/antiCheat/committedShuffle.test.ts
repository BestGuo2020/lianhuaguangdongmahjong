import { describe, expect, it, vi } from 'vitest'
import { createMockVibeRoom } from '../host/mockVibeRoom'
import { combineSeeds, deriveDice, hashSeed, runCommittedShuffle, shuffleTiles } from './committedShuffle'

describe('committedShuffle 纯函数', () => {
  it('shuffleTiles 同种子确定性、不同种子不同结果', () => {
    const tiles = ['a', 'b', 'c', 'd', 'e']
    expect(shuffleTiles(tiles, 'seed1')).toEqual(shuffleTiles(tiles, 'seed1'))
    expect(shuffleTiles(tiles, 'seed1')).not.toEqual(shuffleTiles(tiles, 'seed2'))
  })

  it('shuffleTiles 不丢失元素', () => {
    const tiles = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const shuffled = shuffleTiles(tiles, 'seed')
    expect([...shuffled].sort()).toEqual([...tiles].sort())
  })

  it('combineSeeds 与顺序无关', () => {
    expect(combineSeeds(['a', 'b', 'c'])).toBe(combineSeeds(['c', 'a', 'b']))
  })

  it('deriveDice 返回 1-6', () => {
    for (const seed of ['s1', 's2', 's3', 's4']) {
      const [a, b] = deriveDice(seed)
      expect(a).toBeGreaterThanOrEqual(1)
      expect(a).toBeLessThanOrEqual(6)
      expect(b).toBeGreaterThanOrEqual(1)
      expect(b).toBeLessThanOrEqual(6)
    }
  })

  it('hashSeed 对相同输入一致', async () => {
    expect(await hashSeed('0:abc')).toBe(await hashSeed('0:abc'))
  })

  it('承诺协议完成后，所有参与者共同决定牌墙和两次骰点', async () => {
    const room = createMockVibeRoom(true)
    const onComplete = vi.fn()
    runCommittedShuffle({
      room,
      roundId: 'round-1',
      seatCount: 2,
      mySeat: 0,
      seatByPeer: new Map([['host-peer', 0], ['peer-1', 1]]),
      tiles: ['m1', 'm2', 'm3'],
      randomSeed: () => 'host-seed',
      timeoutMs: 1000,
      onComplete,
    })
    await vi.waitFor(() => expect(room.sent.some((entry) => (entry.message as { type?: string }).type === 'shuffle_commit')).toBe(true))
    room.emit('peer-1', {
      type: 'shuffle_commit',
      roundId: 'round-1',
      seat: 1,
      commitment: await hashSeed('1:peer-seed'),
    })
    room.emit('peer-1', { type: 'shuffle_reveal', roundId: 'round-1', seat: 1, seed: 'peer-seed' })
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(onComplete.mock.calls[0][0]).toHaveLength(3)
    expect(onComplete.mock.calls[0][1]).toHaveLength(2)
    expect(onComplete.mock.calls[0][2]).toHaveLength(2)
  })

  it('后续局承诺拒绝旧房主代次的 commit/reveal', async () => {
    const room = createMockVibeRoom(true)
    const onComplete = vi.fn()
    runCommittedShuffle({
      room,
      roundId: 'round-epoch',
      authorityEpoch: 'epoch-current',
      seatCount: 2,
      mySeat: 0,
      seatByPeer: new Map([['host-peer', 0], ['peer-1', 1]]),
      tiles: ['m1', 'm2', 'm3'],
      randomSeed: () => 'host-seed',
      timeoutMs: 1000,
      onComplete,
    })
    await vi.waitFor(() => expect(room.sent.some((entry) => (entry.message as { type?: string }).type === 'shuffle_commit')).toBe(true))
    const commitment = await hashSeed('1:peer-seed')
    room.emit('peer-1', {
      type: 'shuffle_commit', roundId: 'round-epoch', seat: 1,
      commitment, authorityEpoch: 'epoch-old',
    })
    room.emit('peer-1', {
      type: 'shuffle_reveal', roundId: 'round-epoch', seat: 1,
      seed: 'peer-seed', authorityEpoch: 'epoch-old',
    })
    await Promise.resolve()
    expect(onComplete).not.toHaveBeenCalled()

    room.emit('peer-1', {
      type: 'shuffle_commit', roundId: 'round-epoch', seat: 1,
      commitment, authorityEpoch: 'epoch-current',
    })
    room.emit('peer-1', {
      type: 'shuffle_reveal', roundId: 'round-epoch', seat: 1,
      seed: 'peer-seed', authorityEpoch: 'epoch-current',
    })
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
  })

  it('拒绝伪造座位和冲突重复承诺', async () => {
    const room = createMockVibeRoom(true)
    const onError = vi.fn()
    runCommittedShuffle({
      room,
      roundId: 'round-2',
      seatCount: 2,
      mySeat: 0,
      seatByPeer: new Map([['host-peer', 0], ['peer-1', 1]]),
      tiles: ['m1', 'm2'],
      randomSeed: () => 'host-seed',
      timeoutMs: 1000,
      onComplete: () => {},
      onError,
    })
    await vi.waitFor(() => expect(room.sent.length).toBeGreaterThan(0))
    room.emit('peer-1', { type: 'shuffle_commit', roundId: 'round-2', seat: 0, commitment: 'forged' })
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('来源与座位不匹配'))
  })

  it('首局不接受带有房主代次的迟到承诺', async () => {
    const room = createMockVibeRoom(true)
    const onComplete = vi.fn()
    const onError = vi.fn()
    runCommittedShuffle({
      room,
      roundId: 'round-initial-epoch',
      seatCount: 2,
      mySeat: 0,
      seatByPeer: new Map([['host-peer', 0], ['peer-1', 1]]),
      tiles: ['m1', 'm2', 'm3'],
      randomSeed: () => 'host-seed',
      timeoutMs: 1000,
      onComplete,
      onError,
    })
    await vi.waitFor(() => expect(room.sent.some((entry) => (entry.message as { type?: string }).type === 'shuffle_commit')).toBe(true))

    room.emit('peer-1', {
      type: 'shuffle_commit', roundId: 'round-initial-epoch', seat: 1,
      commitment: await hashSeed('1:peer-seed'), authorityEpoch: 'stale-epoch',
    })
    room.emit('peer-1', {
      type: 'shuffle_reveal', roundId: 'round-initial-epoch', seat: 1,
      seed: 'peer-seed', authorityEpoch: 'stale-epoch',
    })
    await Promise.resolve()

    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('拒绝空承诺和空揭晓种子，不把畸形消息计入屏障', async () => {
    const room = createMockVibeRoom(true)
    const onComplete = vi.fn()
    const onError = vi.fn()
    runCommittedShuffle({
      room,
      roundId: 'round-malformed',
      seatCount: 2,
      mySeat: 0,
      seatByPeer: new Map([['host-peer', 0], ['peer-1', 1]]),
      tiles: ['m1', 'm2'],
      randomSeed: () => 'host-seed',
      timeoutMs: 1000,
      onComplete,
      onError,
    })
    await vi.waitFor(() => expect(room.sent.some((entry) => (entry.message as { type?: string }).type === 'shuffle_commit')).toBe(true))

    room.emit('peer-1', { type: 'shuffle_commit', roundId: 'round-malformed', seat: 1, commitment: '' })
    room.emit('peer-1', { type: 'shuffle_reveal', roundId: 'round-malformed', seat: 1, seed: '' })
    await Promise.resolve()

    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('承诺超时报告未提交座位，供房主切 AI 后重试', async () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const onTimeout = vi.fn()
    runCommittedShuffle({
      room,
      roundId: 'round-timeout',
      seatCount: 4,
      mySeat: 0,
      seatByPeer: new Map([['host-peer', 0], ['peer-1', 1]]),
      tiles: ['m1'],
      randomSeed: () => 'host-seed',
      timeoutMs: 100,
      onComplete: () => {},
      onTimeout,
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(onTimeout).toHaveBeenCalledWith([1])
    vi.useRealTimers()
  })
})
