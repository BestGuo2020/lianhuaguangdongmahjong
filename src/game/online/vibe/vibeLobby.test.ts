import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClientLobby, createHostLobby, type LobbySeat } from './vibeLobby'
import { createMockVibeRoom } from '../host/mockVibeRoom'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

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
    const host = createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      onStart: () => { started = true },
    })
    host.setHostReady(true)
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    room.emit('peer1', { type: 'lobby_ready', ready: true })
    expect(host.requestStart()).toBe(true)
    expect(started).toBe(true)
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

  it('客户端：hello/ready 发送、roster 接收', () => {
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
    expect(room.sent.some((s) => (s.message as { type: string }).type === 'lobby_ready')).toBe(true)
    room.emit('host-peer', {
      type: 'lobby_roster', hostSeat: 0,
      seats: [{ seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false }],
    })
    expect(received).toHaveLength(1)
  })

  it('房主：peer 失联（reconnecting）宽限超时后释放座位，不再占座导致「人越加越多」', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
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
  })

  it('房主：失联宽限期间 peer 恢复（join）→ 取消释放', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
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

  it('房主：失联玩家的同名新窗口（刷新重进）顶替旧座位，不重复占座', () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    createHostLobby({
      room, capacity: 4, hostNickname: '房主', hostAvatar: '',
      staleGraceMs: 10000,
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer-old', { type: 'lobby_hello', nickname: '刷新客', avatar: '' })
    expect(rosters[rosters.length - 1]).toHaveLength(2)
    room.emitPeer({ type: 'reconnecting', id: 'peer-old' })
    // 刷新后新 peerId 加入，昵称相同（同一账号）→ 旧身份仍在宽限中，立即顶替其座位，
    // 不会出现「旧身份占一个座位 + 新身份再占一个」的重复占座。
    room.emit('peer-new', { type: 'lobby_hello', nickname: '刷新客', avatar: '' })
    const after = rosters[rosters.length - 1]
    expect(after).toHaveLength(2)
    expect(after.map((s) => s.peerId)).toEqual(['host-peer', 'peer-new'])
    vi.advanceTimersByTime(10000)
    // 宽限超时：旧身份的定时器已随顶替被清除，座位仍是 2 人、由新身份持有。
    const final = rosters[rosters.length - 1]
    expect(final).toHaveLength(2)
    expect(final.map((s) => s.peerId)).toEqual(['host-peer', 'peer-new'])
  })

  it('客户端：hello 丢失时每 2s 重发，直到收到 roster', () => {
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
    vi.advanceTimersByTime(2000)
    expect(helloSent()).toBe(3)
    // 收到 roster → 停止重发。
    room.emit('host-peer', {
      type: 'lobby_roster', hostSeat: 0,
      seats: [{ seat: 0, peerId: 'host-peer', nickname: '房主', avatar: '', ready: false }],
    })
    vi.advanceTimersByTime(10000)
    expect(helloSent()).toBe(3)
    expect(received).toHaveLength(1)
  })
})
