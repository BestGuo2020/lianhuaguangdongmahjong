import { describe, expect, it } from 'vitest'
import { RemotePlayerController } from './remotePlayerController'
import { createMockVibeRoom } from './mockVibeRoom'
import type { TurnContext } from '../../core/controllers/playerController'

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    hand: ['m1', 'm2', 'm3', 'm4'],
    melds: [{ type: 'peng', tile: 'm5', tiles: ['m5', 'm5', 'm5'] }],
    exposedMelds: 1,
    kongBloom: false,
    skipDraw: false,
    afterKong: false,
    ...overrides,
  }
}

describe('RemotePlayerController', () => {
  it('requestTurn 发 turn_request，并把 discard 响应映射为 TurnAction', async () => {
    const room = createMockVibeRoom()
    const controller = new RemotePlayerController(room, 'peer1')
    const promise = controller.requestTurn(turnContext())
    expect(room.sent[0].to).toBe('peer1')
    expect((room.sent[0].message as { kind: string }).kind).toBe('turn_request')
    room.emit('peer1', { type: 'discard', handIndex: 2 })
    await expect(promise).resolves.toEqual({ kind: 'discard', handIndex: 2 })
  })

  it('hu 响应映射为 win', async () => {
    const room = createMockVibeRoom()
    const controller = new RemotePlayerController(room, 'peer1')
    const promise = controller.requestTurn(turnContext())
    room.emit('peer1', { type: 'hu' })
    await expect(promise).resolves.toEqual({ kind: 'win' })
  })

  it('gang added 按 tile 反查 meldIndex', async () => {
    const room = createMockVibeRoom()
    const controller = new RemotePlayerController(room, 'peer1')
    const promise = controller.requestTurn(turnContext())
    room.emit('peer1', { type: 'gang', kind: 'added', tile: 'm5' })
    await expect(promise).resolves.toEqual({ kind: 'added-kong', meldIndex: 0 })
  })

  it('requestClaim 把 peng/gang/pass 映射为 ClaimAction', async () => {
    const room = createMockVibeRoom()
    const controller = new RemotePlayerController(room, 'peer1')
    const promise = controller.requestClaim({
      hand: ['m1', 'm2'], canPeng: true, canGang: false, tile: 'm1', from: 0,
    })
    room.emit('peer1', { type: 'claim', action: 'peng' })
    await expect(promise).resolves.toEqual({ kind: 'peng' })
  })

  it('requestRobKong 把 hu/pass 映射为 win/pass', async () => {
    const room = createMockVibeRoom()
    const controller = new RemotePlayerController(room, 'peer1')
    const promise = controller.requestRobKong({ tile: 'm1', from: 0, hand: ['m1'], exposedMelds: 0 })
    room.emit('peer1', { type: 'hu' })
    await expect(promise).resolves.toBe('win')
  })

  it('忽略非本 peer 的消息', async () => {
    const room = createMockVibeRoom()
    const controller = new RemotePlayerController(room, 'peer1')
    const promise = controller.requestTurn(turnContext())
    room.emit('peer2', { type: 'discard', handIndex: 1 }) // 非本 peer，应忽略
    room.emit('peer1', { type: 'discard', handIndex: 3 })
    await expect(promise).resolves.toEqual({ kind: 'discard', handIndex: 3 })
  })
})
