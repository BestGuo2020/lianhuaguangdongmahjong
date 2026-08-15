import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createMockVibeClient } from './mockVibeHub'

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 40))

// Node 的 BroadcastChannel 支持同进程多实例互通，正好用来模拟「同浏览器两个窗口」。
describe('mockVibeHub 本地假 SDK', () => {
  it('先加入者为房主，后加入者通过 welcome 获知房主', async () => {
    const host = createMockVibeClient({ settleMs: 30 })
    const guest = createMockVibeClient({ settleMs: 30 })
    const hostRoom = await host.room.join('ABC123')
    const guestRoom = await guest.room.join('ABC123')
    expect(hostRoom.isHost).toBe(true)
    expect(guestRoom.isHost).toBe(false)
    expect(hostRoom.hostId).toBe(hostRoom.peerId)
    expect(guestRoom.hostId).toBe(hostRoom.peerId)
  })

  it('房主 announce 的元数据可被加入方 rooms.get 读到', async () => {
    const host = createMockVibeClient({ settleMs: 30 })
    const guest = createMockVibeClient({ settleMs: 30 })
    const hostRoom = await host.room.join('XYZ789')
    await hostRoom.announce({ listed: false, open: true, max: 4, mode: 'east', rulesetId: 'lotus-classic' })
    await guest.room.join('XYZ789')
    const meta = await guest.rooms.get('XYZ789')
    expect(meta).not.toBeNull()
    expect(meta?.mode).toBe('east')
    expect(meta?.rulesetId).toBe('lotus-classic')
  })

  it('广播消息带 fromPeerId；定向消息只发给目标窗口', async () => {
    const host = createMockVibeClient({ settleMs: 30 })
    const guest = createMockVibeClient({ settleMs: 30 })
    const hostRoom = await host.room.join('ROOM01')
    const guestRoom = await guest.room.join('ROOM01')
    const received: Array<{ message: unknown; from: string }> = []
    guestRoom.onMessage((message, from) => received.push({ message, from }))
    hostRoom.send({ kind: 'hello' })
    await settle()
    expect(received).toHaveLength(1)
    expect(received[0].from).toBe(hostRoom.peerId)
    // 定向给不存在的 peer：目标窗口不应收到
    hostRoom.send({ kind: 'direct' }, 'nobody')
    await settle()
    expect(received).toHaveLength(1)
  })

  it('离开会触发对端 onPeer leave 事件', async () => {
    const host = createMockVibeClient({ settleMs: 30 })
    const guest = createMockVibeClient({ settleMs: 30 })
    const hostRoom = await host.room.join('LEAVE1')
    const guestRoom = await guest.room.join('LEAVE1')
    const events: string[] = []
    hostRoom.onPeer((event) => {
      if (event.type === 'join' || event.type === 'leave') events.push(`${event.type}:${event.id}`)
    })
    guestRoom.leave()
    await settle()
    expect(events).toContain(`leave:${guestRoom.peerId}`)
  })

  it('save 数据存储可读写（战绩走 vibe.save）', async () => {
    const client = createMockVibeClient()
    await client.save.set('player-stats', { matches: 1, wins: 1 })
    const stats = await client.save.get<{ matches: number; wins: number }>('player-stats')
    expect(stats).toEqual({ matches: 1, wins: 1 })
  })

  it('心跳超时判定掉线（模拟标签页关闭）', async () => {
    vi.useFakeTimers()
    try {
      // 房主开启心跳检测；客人关闭心跳（模拟已关闭的标签页不再发任何消息）。
      const host = createMockVibeClient({ settleMs: 20, pingIntervalMs: 100, leaveTimeoutMs: 300 })
      const guest = createMockVibeClient({ settleMs: 20, pingIntervalMs: 0 })
      const hostJoin = host.room.join('HB1')
      await vi.advanceTimersByTimeAsync(100)
      const hostRoom = await hostJoin
      // 监听必须在客人 join 之前注册（join 事件在客人 settle 期间就触发了）。
      const events: Array<`${string}:${string}`> = []
      hostRoom.onPeer((event) => {
        if (event.type === 'join' || event.type === 'leave') events.push(`${event.type}:${event.id}`)
      })
      const guestJoin = guest.room.join('HB1')
      await vi.advanceTimersByTimeAsync(100)
      const guestRoom = await guestJoin
      await vi.advanceTimersByTimeAsync(200)
      expect(events.some((event) => event.startsWith('join:'))).toBe(true)
      // 客人不发任何消息 → 超过 leaveTimeoutMs 后房主判定其掉线。
      await vi.advanceTimersByTimeAsync(500)
      expect(events.some((event) => event === `leave:${guestRoom.peerId}`)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('send 支持 Vue reactive 代理等非结构化克隆对象（内部 JSON 序列化）', async () => {
    // 回归：快照等消息来自 Vue 响应式状态（Proxy），structured clone 会抛
    // DataCloneError；mock 内部必须按真实网络一样做 JSON 序列化。
    const host = createMockVibeClient({ settleMs: 30 })
    const guest = createMockVibeClient({ settleMs: 30 })
    const hostRoom = await host.room.join('PROXY1')
    const guestRoom = await guest.room.join('PROXY1')
    const received: unknown[] = []
    guestRoom.onMessage((message) => received.push(message))
    const proxy = reactive({ kind: 'state_snapshot', players: [{ seat: 0, hand: [] }] })
    hostRoom.send(proxy)
    await settle()
    expect(received).toHaveLength(1)
    expect((received[0] as { kind: string }).kind).toBe('state_snapshot')
  })
})
