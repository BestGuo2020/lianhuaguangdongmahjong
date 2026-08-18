import { afterEach, describe, expect, it, vi } from 'vitest'
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
  afterEach(() => vi.useRealTimers())

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
    const promise = controller.requestTurn(turnContext({ hand: ['m1', 'm2', 'm3', 'm5'] }))
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

  it('拒绝畸形动作，直到收到当前请求的结构合法响应', async () => {
    const room = createMockVibeRoom()
    const controller = new RemotePlayerController(room, 'peer1')
    let settled = false
    const promise = controller.requestTurn(turnContext()).then((action) => {
      settled = true
      return action
    })
    room.emit('peer1', { type: 'discard', handIndex: -1 })
    room.emit('peer1', { type: 'claim', action: 'unknown' })
    room.emit('peer1', { type: 'gang', kind: 'concealed' })
    await Promise.resolve()
    expect(settled).toBe(false)
    room.emit('peer1', { type: 'discard', handIndex: 1 })
    await expect(promise).resolves.toEqual({ kind: 'discard', handIndex: 1 })
  })

  it('房主不会把越过当前手牌或不存在副露的动作直接映射成远端指定动作', async () => {
    const room = createMockVibeRoom()
    const controller = new RemotePlayerController(room, 'peer1')
    const discard = controller.requestTurn(turnContext())
    room.emit('peer1', { type: 'discard', handIndex: 999 })
    await Promise.resolve()
    // 结构合法但越界的动作由房主控制器收下后按安全兜底处理，不能把 999
    // 继续传给引擎；回退到当前上下文的最后一张牌。
    await expect(discard).resolves.toEqual({ kind: 'discard', handIndex: 4 - 1 })

    const added = controller.requestTurn(turnContext({ hand: ['m1', 'm2', 'm3', 'm5'] }))
    room.emit('peer1', { type: 'gang', kind: 'added', tile: 'm9' })
    await expect(added).resolves.toEqual({ kind: 'discard', handIndex: 3 })
  })

  it('房主请求带有代次编号，迟到的旧请求动作不会消费当前请求', async () => {
    const room = createMockVibeRoom()
    const controller = new RemotePlayerController(
      room,
      'peer1',
      undefined,
      undefined,
      undefined,
      { authorityEpoch: 'epoch-1', seat: 2, getRound: () => 2 },
    )
    const promise = controller.requestTurn(turnContext())
    const request = room.sent[0].message as { requestId?: string; requestSeq?: number; round?: number; authorityEpoch?: string; targetSeat?: number }

    expect(request).toMatchObject({ authorityEpoch: 'epoch-1', round: 2, requestSeq: 1, targetSeat: 2 })
    expect(request.requestId).toBe('epoch-1:1')

    room.emit('peer1', { type: 'discard', handIndex: 0, requestId: 'epoch-1:0' })
    room.emit('peer1', { type: 'discard', handIndex: 2, requestId: request.requestId })
    await expect(promise).resolves.toEqual({ kind: 'discard', handIndex: 2 })
  })

  it('AI 接管后迟到的旧动作不能伪造真人恢复', async () => {
    const room = createMockVibeRoom()
    const changes: boolean[] = []
    const controller = new RemotePlayerController(
      room,
      'peer1',
      undefined,
      undefined,
      (ai) => changes.push(ai),
      { authorityEpoch: 'epoch-1', seat: 1, getRound: () => 1 },
    )
    const pending = controller.requestTurn(turnContext())
    const request = room.sent[0].message as { requestId?: string }
    controller.enableAI()
    room.emit('peer1', { type: 'discard', handIndex: 0, requestId: request.requestId })

    await pending
    expect(controller.isAIControlled()).toBe(true)
    expect(changes).toEqual([true])
  })

  it('AI 超时兜底时，旧真人请求不抢先解析并撤销 AI 接管', async () => {
    vi.useFakeTimers()
    const room = createMockVibeRoom()
    const changes: boolean[] = []
    const controller = new RemotePlayerController(
      room,
      'peer1',
      undefined,
      undefined,
      (ai) => changes.push(ai),
      { authorityEpoch: 'epoch-1', seat: 1, getRound: () => 1 },
    )
    controller.enableAI()
    const pending = controller.requestTurn(turnContext())
    await vi.advanceTimersByTimeAsync(22000)
    await vi.advanceTimersByTimeAsync(650)
    await expect(pending).resolves.toMatchObject({ kind: 'discard' })
    expect(controller.isAIControlled()).toBe(true)
    expect(changes).toEqual([true])
  })
})
