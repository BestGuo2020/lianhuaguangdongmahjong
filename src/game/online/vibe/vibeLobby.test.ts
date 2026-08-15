import { describe, expect, it } from 'vitest'
import { createClientLobby, createHostLobby, type LobbySeat } from './vibeLobby'
import { createMockVibeRoom } from '../host/mockVibeRoom'

describe('vibeLobby', () => {
  it('房主：peer hello 后分配座位、广播 roster', () => {
    const room = createMockVibeRoom(true)
    const rosters: LobbySeat[][] = []
    createHostLobby({
      room, capacity: 4, hostNickname: '房主',
      onRoster: (seats) => rosters.push(seats),
      onStart: () => {},
    })
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1' })
    expect(rosters[rosters.length - 1]).toEqual([
      { seat: 0, peerId: 'host-peer', nickname: '房主', ready: false },
      { seat: 1, peerId: 'peer1', nickname: '玩家1', ready: false },
    ])
  })

  it('房主：全员就绪后 requestStart 广播 lobby_start', () => {
    const room = createMockVibeRoom(true)
    let started = false
    const host = createHostLobby({
      room, capacity: 4, hostNickname: '房主',
      onStart: () => { started = true },
    })
    host.setHostReady(true)
    room.emit('peer1', { type: 'lobby_hello', nickname: '玩家1' })
    room.emit('peer1', { type: 'lobby_ready', ready: true })
    expect(host.requestStart()).toBe(true)
    expect(started).toBe(true)
    expect(room.sent.some((s) => (s.message as { type: string }).type === 'lobby_start')).toBe(true)
  })

  it('房主独玩（无 peer）也能开局：空席 AI 补位', () => {
    const room = createMockVibeRoom(true)
    let started = false
    const host = createHostLobby({
      room, capacity: 4, hostNickname: '房主',
      onStart: () => { started = true },
    })
    host.setHostReady(true)
    expect(host.requestStart()).toBe(true)
    expect(started).toBe(true)
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
      seats: [{ seat: 0, peerId: 'host-peer', nickname: '房主', ready: false }],
    })
    expect(received).toHaveLength(1)
  })
})
