import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClientLobby, createHostLobby, isHostLobbyMessage, type LobbySeat } from './vibeLobby'
import { createMockVibeRoom, type MockVibeRoom } from '../host/mockVibeRoom'
import { createMockVibeClient } from './mockVibeHub'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 覆写 mock room 的 peers()：真实 SDK 会返回在线对端，mock 固定返回 []，
 * 会导致 hostLobby 的对端在场轮询把所有已登记 peer 误判为「已消失」。 */
function stubOnlinePeers(room: MockVibeRoom, online: () => string[]) {
  const original = room.peers
  room.peers = () => online().map((id) => ({
    id, open: true, latency: 5, jitter: 0, relay: false, realtime: true, reconnecting: false,
  }))
  return () => { room.peers = original }
}

describe('vibeLobby', () => {
  it('房主：peer hello 后分配座位、广播 roster', () => {
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    expect(rosters[rosters.length - 1]).toEqual([
      { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false },
      { seat: 1, peerId: 'peer1', nickname: '玩家1', avatar: '', ready: false },
    ])
  })

  it('房主：全员就绪后 requestStart 广播 lobby_start', () => {
    const room = createMockVibeRoom(true)
    let started = false
    let startSeatCount = 0
    const host = createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      onStart: ({ seatCount }) => { started = true; startSeatCount = seatCount },
    })
    host.setHostReady(true)
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    room.emit('peer1', { type: 'lobby_ready', ready: true })
    expect(host.requestStart()).toBe(true)
    expect(started).toBe(true)
    expect(startSeatCount).toBe(4)
    const startMessage = room.sent.find((s) => (s.message as { type: string }).type === 'lobby_start')?.message as {
      seatCount: number
      rosterRevision: number
      participants?: Array<{ seat: number; peerId: string }>
    }
    expect(startMessage.seatCount).toBe(4)
    expect(startMessage.rosterRevision).toBeGreaterThan(0)
    expect(startMessage.participants).toEqual([
      { seat: 0, peerId: 'host-peer' },
      { seat: 1, peerId: 'peer1' },
    ])
    expect(room.sent.some((s) => (s.message as { type: string }).type === 'lobby_start')).toBe(true)
  })

  it('房主独玩（无 peer）也能开局：空席 AI 补位', () => {
    const room = createMockVibeRoom(true)
    let started = false
    const host = createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      onStart: () => { started = true },
    })
    host.setHostReady(true)
    expect(host.requestStart()).toBe(true)
    expect(started).toBe(true)
  })

  it('房主收到 lobby_leave 后释放座位', () => {
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    expect(rosters[rosters.length - 1]).toHaveLength(2)
    room.emit('peer1', { type: 'lobby_leave' })
    expect(rosters[rosters.length - 1]).toEqual([
      { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false },
    ])
  })

  it('客户端：hello/ready 发送、roster 接收', async () => {
    const room = createMockVibeRoom(false)
    const received: LobbySeat[][] = []
    const client = createClientLobby({
      room,
      onRoster: (_hostSeat, seats) => received.push(seats),
      onStart: () => {},
      onClosed: () => {},
    })
    client.hello('玩家')
    client.setReady(true)
    expect(room.sent.some((s) => (s.message as { type: string }).type === 'lobby_hello')).toBe(true)
    // ready 要等房主 roster 确认本端座位后发送，避免 hello/ready 竞态被房主丢弃。
    expect(room.sent.some((s) => (s.message as { type: string }).type === 'lobby_ready')).toBe(false)
    room.emit('host-peer', {
      type: 'lobby_roster', hostSeat: 0, revision: 1,
      seats: [
        { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false },
        { seat: 1, peerId: room.peerId, nickname: '玩家', avatar: '', ready: false },
      ],
    })
    expect(received).toHaveLength(1)
    await Promise.resolve()
    expect(room.sent.some((s) => (s.message as { type: string }).type === 'lobby_ready')).toBe(true)
  })

  it('客户端只接受房主 roster 的单调 revision，迟到旧名单不能回滚座位', () => {
    const room = createMockVibeRoom(false)
    const received: LobbySeat[][] = []
    const client = createClientLobby({
      room,
      onRoster: (_hostSeat, seats) => received.push(seats),
      onStart: () => {},
      onClosed: () => {},
    })
    client.hello('玩家')

    room.emit('host-peer', {
      type: 'lobby_roster', hostSeat: 0, revision: 2,
      seats: [
        { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false },
        { seat: 2, peerId: room.peerId, nickname: '新座位', avatar: '', ready: true },
      ],
    })
    room.emit('host-peer', {
      type: 'lobby_roster', hostSeat: 0, revision: 1,
      seats: [
        { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false },
        { seat: 1, peerId: room.peerId, nickname: '旧座位', avatar: '', ready: false },
      ],
    })

    expect(received).toHaveLength(1)
    expect(received[0][1]).toMatchObject({ seat: 2, nickname: '新座位', ready: true })
  })

  it('客户端在 roster 之前收到 lobby_start 时先等待座位，再只启动一次', () => {
    const room = createMockVibeRoom(false)
    const started = vi.fn()
    const client = createClientLobby({
      room,
      onRoster: () => {},
      onStart: started,
      onClosed: () => {},
    })
    client.hello('玩家')

    room.emit('host-peer', {
      type: 'lobby_start', shuffleId: 'shuffle-1', seatCount: 4, rosterRevision: 1,
      participants: [{ seat: 0, peerId: 'host-peer' }, { seat: 1, peerId: room.peerId }],
    })
    expect(started).not.toHaveBeenCalled()
    room.emit('host-peer', {
      type: 'lobby_roster', hostSeat: 0, revision: 1,
      seats: [
        { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: true },
        { seat: 1, peerId: room.peerId, nickname: '玩家', avatar: '', ready: true },
      ],
    })
    expect(started).toHaveBeenCalledTimes(1)
    room.emit('host-peer', {
      type: 'lobby_start', shuffleId: 'shuffle-1', seatCount: 4, rosterRevision: 1,
      participants: [{ seat: 0, peerId: 'host-peer' }, { seat: 1, peerId: room.peerId }],
    })
    expect(started).toHaveBeenCalledTimes(1)
  })

  it('lobby_start 必须携带房主锁定的参与者映射，且座位不能超出 seatCount', () => {
    expect(isHostLobbyMessage({ type: 'lobby_start', shuffleId: 's', seatCount: 4, rosterRevision: 1 })).toBe(false)
    expect(isHostLobbyMessage({
      type: 'lobby_start', shuffleId: 's', seatCount: 1, rosterRevision: 1,
      participants: [{ seat: 1, peerId: 'peer-1' }],
    })).toBe(false)
    expect(isHostLobbyMessage({
      type: 'lobby_start', shuffleId: 's', seatCount: 4, rosterRevision: 1,
      participants: [{ seat: 0, peerId: 'host-peer' }, { seat: 1, peerId: 'peer-1' }],
    })).toBe(true)
  })

  it('迟到的旧 rosterRevision 开局不能覆盖当前名单', () => {
    const room = createMockVibeRoom(false)
    const started = vi.fn()
    const client = createClientLobby({
      room,
      onRoster: () => {},
      onStart: started,
      onClosed: () => {},
    })
    client.hello('玩家')

    room.emit('host-peer', {
      type: 'lobby_roster', hostSeat: 0, revision: 2,
      seats: [
        { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: true },
        { seat: 1, peerId: room.peerId, nickname: '玩家', avatar: '', ready: true },
      ],
    })
    room.emit('host-peer', {
      type: 'lobby_start', shuffleId: 'stale', seatCount: 4, rosterRevision: 1,
      participants: [{ seat: 0, peerId: 'host-peer' }, { seat: 1, peerId: room.peerId }],
    })

    expect(started).not.toHaveBeenCalled()
  })

  it('四个真实 Mock SDK 客户端最终收到同一份房主 roster', async () => {
    const roomId = `LOBBY4-${Date.now().toString(36)}`
    const clients = ['lobby-host', 'lobby-p1', 'lobby-p2', 'lobby-p3'].map((peerId) => (
      createMockVibeClient({ peerId, settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    ))
    const hostRoom = await clients[0].room.join(roomId)
    const hostRosters: LobbySeat[][] = []
    const hostLobby = createHostLobby({
      room: hostRoom,
      capacity: 4,
      hostNickname: '房主',
      hostAvatar: '',
      onRoster: (seats) => hostRosters.push(seats),
      onStart: () => {},
    })
    const guestLobbies: Array<ReturnType<typeof createClientLobby>> = []
    const guestRosters: LobbySeat[][][] = [[], [], []]

    try {
      for (let index = 1; index < clients.length; index += 1) {
        const guestRoom = await clients[index].room.join(roomId)
        const guestLobby = createClientLobby({
          room: guestRoom,
          onRoster: (_hostSeat, seats) => guestRosters[index - 1].push(seats),
          onStart: () => {},
          onClosed: () => {},
        })
        guestLobbies.push(guestLobby)
        guestLobby.hello(`玩家${index}`, '', `stable-${index}`)
      }

      await new Promise((resolve) => setTimeout(resolve, 100))
      const expected = '0:lobby-host|1:lobby-p1|2:lobby-p2|3:lobby-p3'
      expect(hostRosters.at(-1)?.map((seat) => `${seat.seat}:${seat.peerId}`).join('|')).toBe(expected)
      for (const rosters of guestRosters) {
        expect(rosters.at(-1)?.map((seat) => `${seat.seat}:${seat.peerId}`).join('|')).toBe(expected)
      }
    } finally {
      guestLobbies.forEach((lobby) => lobby.leave())
      hostLobby.close()
      hostRoom.leave()
    }
  })

  it('客户端：只向房主发送 seatToken，并只接受分配给本座位的 token', () => {
    const room = createMockVibeRoom(false)
    const receivedTokens: string[] = []
    const client = createClientLobby({
      room,
      onRoster: () => {},
      onSeatToken: (token) => receivedTokens.push(token),
      onStart: () => {},
      onClosed: () => {},
    })
    client.hello('玩家', '', 'user-1', 'saved-token')
    expect(room.sent.find((entry) => (entry.message as { type?: string }).type === 'lobby_hello')?.message)
      .toMatchObject({ playerId: 'user-1', seatToken: 'saved-token' })

    // token 可能因 SDK 消息乱序先到；在 roster 确认本座位前必须忽略。
    room.emit('host-peer', { type: 'lobby_seat_token', seat: 1, token: 'too-early' })
    expect(receivedTokens).toEqual([])

    room.emit('host-peer', {
      type: 'lobby_roster', hostSeat: 0, revision: 1,
      seats: [
        { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false },
        { seat: 2, peerId: room.peerId, nickname: '玩家', avatar: '', ready: false },
      ],
    })
    room.emit('host-peer', { type: 'lobby_seat_token', seat: 1, token: 'wrong-seat' })
    room.emit('host-peer', { type: 'lobby_seat_token', seat: 2, token: 'new-token' })
    expect(receivedTokens).toEqual(['new-token'])
  })

  it('客户端忽略非房主伪造的大厅控制消息', () => {
    const room = createMockVibeRoom(false)
    const received: LobbySeat[][] = []
    const started = vi.fn()
    const closed = vi.fn()
    const client = createClientLobby({
      room,
      onRoster: (_hostSeat, seats) => received.push(seats),
      onStart: started,
      onClosed: closed,
    })
    client.hello('玩家')

    room.emit('peer2', {
      type: 'lobby_roster', hostSeat: 0, revision: 1,
      seats: [{ seat: 1, peerId: room.peerId, nickname: '伪造', avatar: '', ready: true }],
    })
    room.emit('peer2', {
      type: 'lobby_start', shuffleId: 'forged', seatCount: 4, rosterRevision: 1,
      participants: [{ seat: 0, peerId: 'peer2' }, { seat: 1, peerId: room.peerId }],
    })
    room.emit('peer2', { type: 'lobby_closed' })

    expect(received).toHaveLength(0)
    expect(started).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
  })

  it('客户端拒绝房主来源中 seat 0 非当前 SDK 房主的异常 roster', () => {
    const room = createMockVibeRoom(false)
    const received: LobbySeat[][] = []
    const client = createClientLobby({
      room,
      onRoster: (_hostSeat, seats) => received.push(seats),
      onStart: () => {},
      onClosed: () => {},
    })
    client.hello('玩家')
    room.emit('host-peer', {
      type: 'lobby_roster', hostSeat: 0, revision: 1,
      seats: [
        { seat: 0, peerId: 'other-peer', nickname: '伪房主', avatar: '', ready: true },
        { seat: 1, peerId: room.peerId, nickname: '玩家', avatar: '', ready: true },
      ],
    })
    expect(received).toHaveLength(0)
  })

  it('房主：peer 失联（reconnecting）宽限超时后释放座位，不再占座导致「人越加越多」', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    const online = ['peer1', 'peer2']
    const restorePeers = stubOnlinePeers(room, () => online)
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      staleGraceMs: 10000,
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    room.emit('peer2', { type: 'lobby_hello', nickname: '玩家2', avatar: '' })
    expect(rosters[rosters.length - 1]).toHaveLength(3)
    // 玩家1 掉线：真实 SDK 只报 reconnecting（不报 leave）。
    room.emitPeer({ type: 'reconnecting', id: 'peer1' })
    // 宽限内座位保留。
    expect(rosters[rosters.length - 1]).toHaveLength(3)
    vi.advanceTimersByTime(10000)
    // 宽限超时 → 座位释放，新玩家可加入。
    expect(rosters[rosters.length - 1]).toHaveLength(2)
    expect(rosters[rosters.length - 1].map((s) => s.peerId).sort()).toEqual(['host-peer', 'peer2'])
    room.emit('peer3', { type: 'lobby_hello', nickname: '玩家3', avatar: '' })
    expect(rosters[rosters.length - 1]).toHaveLength(3)
    expect(rosters[rosters.length - 1].map((s) => s.peerId).sort()).toEqual(['host-peer', 'peer2', 'peer3'])
    restorePeers()
  })

  it('房主：不轮询 SDK 列表；只响应 onPeer 连接事件释放座位', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    // 覆写 peers 模拟 SDK 静默移除对端。
    const online: string[] = ['peer1']
    const restorePeers = stubOnlinePeers(room, () => online)
    const rosters: LobbySeat[][] = []
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    expect(rosters[rosters.length - 1]).toHaveLength(2)
    // 仅修改 peers() 且不发 SDK 事件，不应触发任何应用层轮询。
    online.splice(0)
    vi.advanceTimersByTime(60000)
    expect(rosters[rosters.length - 1]).toHaveLength(2)
    room.emitPeer({ type: 'reconnecting', id: 'peer1' })
    vi.advanceTimersByTime(10000)
    expect(rosters[rosters.length - 1]).toHaveLength(1)
    restorePeers()
  })

  it('房主：失联宽限期间 peer 恢复（join）→ 取消释放', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    const restorePeers = stubOnlinePeers(room, () => ['peer1'])
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      staleGraceMs: 10000,
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    room.emitPeer({ type: 'reconnecting', id: 'peer1' })
    vi.advanceTimersByTime(5000)
    room.emitPeer({ type: 'join', id: 'peer1' })
    vi.advanceTimersByTime(10000)
    // 恢复后不再释放。
    expect(rosters[rosters.length - 1].map((s) => s.peerId)).toEqual(['host-peer', 'peer1'])
    restorePeers()
  })

  it('房主：P2P 切换 relay → 取消座位释放宽限', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    const restorePeers = stubOnlinePeers(room, () => ['peer1'])
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      staleGraceMs: 10000,
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    room.emitPeer({ type: 'reconnecting', id: 'peer1' })
    vi.advanceTimersByTime(5000)
    room.emitPeer({ type: 'relay', id: 'peer1', active: true })
    vi.advanceTimersByTime(10000)
    expect(rosters[rosters.length - 1].map((s) => s.peerId)).toEqual(['host-peer', 'peer1'])
    restorePeers()
  })

  it('房主：对局中（isInMatch）失联不释放座位（座位锁定给 AI 代打）', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      staleGraceMs: 10000,
      isInMatch: () => true,
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    room.emitPeer({ type: 'reconnecting', id: 'peer1' })
    vi.advanceTimersByTime(30000)
    expect(rosters[rosters.length - 1].map((s) => s.peerId)).toEqual(['host-peer', 'peer1'])
  })

  it('房主：对局中 leave/lobby_leave 不释放座位，新 peerId 按稳定身份恢复原座位', () => {
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      isInMatch: () => true,
      generateSeatToken: () => 'token-1',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer-old', { type: 'lobby_hello', nickname: '玩家1', avatar: '', playerId: 'user-1' })
    room.emit('peer-old', { type: 'lobby_leave' })
    expect(rosters[rosters.length - 1]).toEqual([
      { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false },
      { seat: 1, peerId: 'peer-old', nickname: '玩家1', avatar: '', ready: false },
    ])

    room.emitPeer({ type: 'leave', id: 'peer-old' })
    expect(rosters[rosters.length - 1]).toHaveLength(2)

    room.emit('peer-new', { type: 'lobby_hello', nickname: '玩家1', avatar: '', playerId: 'user-1', seatToken: 'token-1' })
    expect(rosters[rosters.length - 1].map((seat) => `${seat.seat}:${seat.peerId}`)).toEqual([
      '0:host-peer', '1:peer-new',
    ])
  })

  it('房主：失联玩家的同名新窗口（刷新重进）顶替旧座位，不重复占座', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      staleGraceMs: 10000,
      generateSeatToken: () => 'token-refresh',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    const restorePeers = stubOnlinePeers(room, () => ['peer-old', 'peer-new'])
    room.emit('peer-old', { type: 'lobby_hello', nickname: '刷新客', avatar: '', playerId: 'user-refresh' })
    expect(rosters[rosters.length - 1]).toHaveLength(2)
    room.emitPeer({ type: 'reconnecting', id: 'peer-old' })
    // 刷新后新 peerId 加入，稳定 playerId 相同（昵称只是展示字段）→ 旧身份仍在宽限中，立即顶替其座位，
    // 不会出现「旧身份占一个座位 + 新身份再占一个」的重复占座。
    room.emit('peer-new', { type: 'lobby_hello', nickname: '刷新客', avatar: '', playerId: 'user-refresh', seatToken: 'token-refresh' })
    const after = rosters[rosters.length - 1]
    expect(after).toHaveLength(2)
    expect(after.map((s) => s.peerId)).toEqual(['host-peer', 'peer-new'])
    vi.advanceTimersByTime(10000)
    // 宽限超时：旧身份的定时器已随顶替被清除，座位仍是 2 人、由新身份持有。
    const final = rosters[rosters.length - 1]
    expect(final).toHaveLength(2)
    expect(final.map((s) => s.peerId)).toEqual(['host-peer', 'peer-new'])
    restorePeers()
  })

  it('房主：旧 peer 尚未离开时，带有效 token 的同账号新 peer 原子继承原座位', () => {
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    const host = createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      generateSeatToken: () => 'token-atomic',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })

    room.emit('peer-old', { type: 'lobby_hello', nickname: '账号2', avatar: '', playerId: 'account-2' })
    room.emit('peer-old', { type: 'lobby_ready', ready: true })
    room.emit('peer-new', { type: 'lobby_hello', nickname: '账号2', avatar: '', playerId: 'account-2', seatToken: 'token-atomic' })

    expect(rosters.at(-1)?.map((seat) => `${seat.seat}:${seat.peerId}`)).toEqual([
      '0:host-peer', '1:peer-new',
    ])
    expect(rosters.at(-1)?.find((seat) => seat.seat === 1)?.ready).toBe(true)

    // 旧 peer 的迟到消息不能把新连接的座位或准备态改回去。
    room.emit('peer-old', { type: 'lobby_ready', ready: true })
    room.emit('peer-new', { type: 'lobby_ready', ready: true })
    room.emitPeer({ type: 'leave', id: 'peer-old' })
    expect(rosters.at(-1)).toEqual([
      { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false },
      { seat: 1, peerId: 'peer-new', nickname: '账号2', avatar: '', ready: true },
    ])

    host.setHostReady(true)
    expect(host.requestStart()).toBe(true)
  })

  it('房主：重复 playerId 没有有效 token 时不分配下一个座位', () => {
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })

    room.emit('peer-old', { type: 'lobby_hello', nickname: '账号2', avatar: '', playerId: 'account-2' })
    room.emit('peer-new', { type: 'lobby_hello', nickname: '账号2', avatar: '', playerId: 'account-2' })

    expect(rosters.at(-1)?.map((seat) => `${seat.seat}:${seat.peerId}`)).toEqual([
      '0:host-peer', '1:peer-old',
    ])
  })

  it('房主：只伪造 playerId、没有房主 token 时不能夺取对局座位', () => {
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    createHostLobby({
      room, capacity: 2, hostNickname: '房主', hostAvatar: '',
      isInMatch: () => true,
      generateSeatToken: () => 'secret-seat-token',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer-old', { type: 'lobby_hello', nickname: '玩家1', avatar: '', playerId: 'user-1' })
    room.emit('peer-new', { type: 'lobby_hello', nickname: '冒充者', avatar: '', playerId: 'user-1' })

    expect(rosters[rosters.length - 1].map((seat) => `${seat.seat}:${seat.peerId}`)).toEqual([
      '0:host-peer', '1:peer-old',
    ])
  })

  it('客户端：hello 丢失时有界重试，roster 就绪后单次确认业务监听且不持续轮询', async () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(false)
    const received: LobbySeat[][] = []
    const client = createClientLobby({
      room,
      onRoster: (_hostSeat, seats) => received.push(seats),
      onStart: () => {},
      onClosed: () => {},
    })
    client.hello('玩家')
    const helloSent = () => room.sent.filter((s) => (s.message as { type: string }).type === 'lobby_hello').length
    expect(helloSent()).toBe(1)
    // 首次 hello 丢失（房主没回 roster）→ 2s 后重发。
    vi.advanceTimersByTime(2000)
    expect(helloSent()).toBe(2)
    vi.advanceTimersByTime(20000)
    expect(helloSent()).toBe(2)
    // 收到 roster → 停止重发。
    room.emit('host-peer', {
      type: 'lobby_roster', hostSeat: 0, revision: 1,
      seats: [
        { seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false },
        { seat: 1, peerId: room.peerId, nickname: '玩家', avatar: '', ready: false },
      ],
    })
    await Promise.resolve()
    expect(helloSent()).toBe(3)
    vi.advanceTimersByTime(10000)
    expect(helloSent()).toBe(3)
    expect(received).toHaveLength(1)
  })

  it('客户端：hello 后不建立 lobby_ping 周期心跳', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(false)
    const client = createClientLobby({ room, onRoster: () => {}, onStart: () => {}, onClosed: () => {} })
    client.hello('玩家')
    const pingCount = () => room.sent.filter((s) => (s.message as { type: string }).type === 'lobby_ping').length
    vi.advanceTimersByTime(60000)
    expect(pingCount()).toBe(0)
    client.leave()
    expect(pingCount()).toBe(0)
  })

  it('房主：没有 SDK 连接事件时不按心跳超时释放座位', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    const restorePeers = stubOnlinePeers(room, () => ['peer1'])
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    expect(rosters[rosters.length - 1]).toHaveLength(2)
    // 不再维护应用层心跳；时间推进本身不能改变座位。
    vi.advanceTimersByTime(55000)
    expect(rosters[rosters.length - 1]).toHaveLength(2)
    restorePeers()
  })

  it('房主：心跳未超时（在线且活跃）→ 不释放', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    const restorePeers = stubOnlinePeers(room, () => ['peer1'])
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    // 客户端每 15s 发 ping（模拟 3 次）。
    vi.advanceTimersByTime(15000)
    room.emit('peer1', { type: 'lobby_ping' })
    vi.advanceTimersByTime(15000)
    room.emit('peer1', { type: 'lobby_ping' })
    vi.advanceTimersByTime(15000)
    expect(rosters[rosters.length - 1]).toHaveLength(2) // 一直有心跳 → 座位保留
    restorePeers()
  })
})
