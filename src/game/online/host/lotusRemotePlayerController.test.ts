import { describe, expect, it } from 'vitest'
import { LotusRemotePlayerController } from './lotusRemotePlayerController'
import { createMockVibeRoom } from './mockVibeRoom'
import type { LotusHuContext, LotusTurnContext } from '../../variants/lotus/lotusControllers'

function turnContext(): LotusTurnContext {
  return {
    hand: ['m1', 'm2', 'm3', 'm4'],
    melds: [],
    exposedMelds: 0,
    kongBloom: false,
    skipDraw: false,
    isDealer: true,
    jokers: [],
  }
}

function huContext(): LotusHuContext {
  return {
    hand: ['m1', 'm2'],
    exposedMelds: 0,
    tile: 'm1',
    from: 0,
    dihu: true,
    jokers: [],
    canPeng: true,
    canGang: false,
    chiOptions: [{ kind: 'sequence', tiles: ['m1', 'm2', 'm3'] }],
  }
}

describe('LotusRemotePlayerController', () => {
  it('wind-kong 映射', async () => {
    const room = createMockVibeRoom()
    const controller = new LotusRemotePlayerController(room, 'peer1')
    const promise = controller.requestTurn(turnContext())
    room.emit('peer1', { type: 'gang', kind: 'wind' })
    await expect(promise).resolves.toEqual({ kind: 'wind-kong' })
  })

  it('requestDiscardHu 发合并 claim_request，hu 映射为 win', async () => {
    const room = createMockVibeRoom()
    const controller = new LotusRemotePlayerController(room, 'peer1')
    const promise = controller.requestDiscardHu(huContext())
    const sent = room.sent[0].message as { kind: string; ctx: { canHu?: boolean; canPeng?: boolean; chiOptions?: unknown[] } }
    expect(sent.kind).toBe('claim_request')
    expect(sent.ctx.canHu).toBe(true)
    expect(sent.ctx.canPeng).toBe(true)
    expect(sent.ctx.chiOptions).toHaveLength(1)
    room.emit('peer1', { type: 'hu' })
    await expect(promise).resolves.toEqual({ kind: 'win' })
  })

  it('requestDiscardHu 的 chi 响应映射为 chi(meld)', async () => {
    const room = createMockVibeRoom()
    const controller = new LotusRemotePlayerController(room, 'peer1')
    const promise = controller.requestDiscardHu(huContext())
    room.emit('peer1', { type: 'claim', action: 'chi', optionIndex: 0 })
    await expect(promise).resolves.toEqual({ kind: 'chi', meld: { kind: 'sequence', tiles: ['m1', 'm2', 'm3'] } })
  })

  it('requestChi 发专用 claim_request，pass 映射', async () => {
    const room = createMockVibeRoom()
    const controller = new LotusRemotePlayerController(room, 'peer1')
    const promise = controller.requestChi({
      hand: ['m1', 'm2'], tile: 'm1', from: 0,
      chiOptions: [{ kind: 'sequence', tiles: ['m1', 'm2', 'm3'] }], jokers: [],
    })
    room.emit('peer1', { type: 'pass' })
    await expect(promise).resolves.toEqual({ kind: 'pass' })
  })

  it('requestClaim 携带 chiOptions 且 chi 响应映射为 chi(meld)（修复下家吃牌按钮消失）', async () => {
    const room = createMockVibeRoom()
    const controller = new LotusRemotePlayerController(room, 'peer1')
    const promise = controller.requestClaim({
      hand: ['m1', 'm2'], exposedMelds: 0, tile: 'm3', from: 0,
      canPeng: false, canGang: false,
      chiOptions: [{ kind: 'sequence', tiles: ['m1', 'm2', 'm3'] }], jokers: [],
    })
    const sent = room.sent[0].message as { kind: string; ctx: { chiOptions?: unknown[] } }
    expect(sent.kind).toBe('claim_request')
    // 回归：此前 chiOptions 漏传，只能吃（不能碰/杠）的下家看不到「吃」按钮。
    expect(sent.ctx.chiOptions).toHaveLength(1)
    room.emit('peer1', { type: 'claim', action: 'chi', optionIndex: 0 })
    await expect(promise).resolves.toEqual({ kind: 'chi', meld: { kind: 'sequence', tiles: ['m1', 'm2', 'm3'] } })
  })
})
