import { describe, expect, it, vi } from 'vitest'
import { AiController } from './playerController'
import type { ClaimContext, RobKongContext, TurnContext } from './playerController'
import type { Meld, TileType } from './types'

function makeTurnCtx(hand: TileType[], overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    hand,
    melds: overrides.melds ?? [],
    exposedMelds: overrides.exposedMelds ?? 0,
    kongBloom: overrides.kongBloom ?? false,
    skipDraw: overrides.skipDraw ?? false,
    afterKong: overrides.afterKong ?? false,
  }
}

function makeClaimCtx(hand: TileType[], overrides: Partial<ClaimContext> = {}): ClaimContext {
  return {
    hand,
    canGang: overrides.canGang ?? false,
    tile: overrides.tile ?? 'east',
    from: overrides.from ?? 1,
  }
}

function makeRobCtx(overrides: Partial<RobKongContext> = {}): RobKongContext {
  return {
    tile: overrides.tile ?? 'east',
    from: overrides.from ?? 2,
    hand: overrides.hand ?? ['east', 'east', 'm1', 'm2'],
    exposedMelds: overrides.exposedMelds ?? 1,
  }
}

describe('AiController.requestTurn', () => {
  it('自摸可胡时返回 win', async () => {
    const controller = new AiController({ turn: 0, afterKong: 0, claim: 0 })
    const hand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east']
    const action = await controller.requestTurn(makeTurnCtx(hand))
    expect(action).toEqual({ kind: 'win' })
  })

  it('已碰且有第四张时返回 added-kong', async () => {
    const controller = new AiController({ turn: 0, afterKong: 0, claim: 0 })
    const melds: Meld[] = [{ type: 'peng', tile: 'east', from: 1, tiles: ['east', 'east', 'east'] }]
    const hand: TileType[] = ['east', 'm1', 'm2']
    const action = await controller.requestTurn(makeTurnCtx(hand, { melds, exposedMelds: 1 }))
    expect(action).toEqual({ kind: 'added-kong', meldIndex: 0 })
  })

  it('暗杠在手时返回 concealed-kong', async () => {
    const controller = new AiController({ turn: 0, afterKong: 0, claim: 0 })
    const hand: TileType[] = ['s7', 's7', 's7', 's7', 'm1', 'm2', 'm3', 'p4', 'p5', 'east', 'east']
    const action = await controller.requestTurn(makeTurnCtx(hand))
    expect(action).toEqual({ kind: 'concealed-kong', tile: 's7' })
  })

  it('无胡无杠时返回 discard', async () => {
    const controller = new AiController({ turn: 0, afterKong: 0, claim: 0 })
    const hand: TileType[] = ['m1', 'p4', 'p5', 'p6', 'east', 's2', 's2', 's9', 's9', 'white', 'white']
    const action = await controller.requestTurn(makeTurnCtx(hand))
    expect(action.kind).toBe('discard')
    if (action.kind === 'discard') {
      expect(action.handIndex).toBeGreaterThanOrEqual(0)
      expect(action.handIndex).toBeLessThan(hand.length)
    }
  })

  it('afterKong 使用更短的 kong 延迟', async () => {
    const calls: number[] = []
    const scheduler = (fn: () => void, ms: number) => { calls.push(ms); fn() }
    const controller = new AiController({ turn: 650, afterKong: 300, claim: 500 }, scheduler)
    await controller.requestTurn(makeTurnCtx(['m1', 'm2', 'p4', 'p5', 'p6', 'east', 's2', 's2', 's9', 's9', 'white', 'white'], { afterKong: true }))
    expect(calls).toEqual([300])
  })

  it('普通回合使用 turn 延迟', async () => {
    const calls: number[] = []
    const scheduler = (fn: () => void, ms: number) => { calls.push(ms); fn() }
    const controller = new AiController({ turn: 650, afterKong: 300, claim: 500 }, scheduler)
    await controller.requestTurn(makeTurnCtx(['m1', 'm2', 'p4', 'p5', 'p6', 'east', 's2', 's2', 's9', 's9', 'white', 'white']))
    expect(calls).toEqual([650])
  })
})

describe('AiController.requestClaim', () => {
  it('canGang 时返回 gang', async () => {
    const controller = new AiController({ turn: 0, afterKong: 0, claim: 0 })
    const action = await controller.requestClaim(makeClaimCtx(['east', 'east', 'east', 'm1'], { canGang: true }))
    expect(action).toEqual({ kind: 'gang' })
  })

  it('无 gang 时返回 peng 并携带 discardIndex', async () => {
    const controller = new AiController({ turn: 0, afterKong: 0, claim: 0 }, (fn) => fn(), () => 0)
    const action = await controller.requestClaim(makeClaimCtx(['east', 'east', 'm1', 'm2'], { canGang: false, tile: 'east' }))
    expect(action.kind).toBe('peng')
    if (action.kind === 'peng') {
      expect(action.discardIndex).toBeGreaterThanOrEqual(0)
    }
  })

  it('peng 的 discardIndex 基于碰后手牌计算', async () => {
    // hand = ['east', 'east', 'p5', 'p5', 'm1']，碰 east 后剩余 ['p5', 'p5', 'm1']
    // m1 是孤张（无对无靠），评分最低，应被优先弃掉 → index 2
    const controller = new AiController({ turn: 0, afterKong: 0, claim: 0 }, (fn) => fn(), () => 0)
    const action = await controller.requestClaim(makeClaimCtx(['east', 'east', 'p5', 'p5', 'm1'], { canGang: false, tile: 'east' }))
    expect(action.kind).toBe('peng')
    if (action.kind === 'peng') {
      // discardIndex 对应碰后手牌中的位置：['p5', 'p5', 'm1'] → m1 在 index 2
      expect(action.discardIndex).toBe(2)
    }
  })

  it('碰后无牌可打时返回 pass（防止出牌空手卡死）', async () => {
    // hand 恰好只剩要碰的 2 张 east：碰后手牌为空，真实规则下不能碰
    const controller = new AiController({ turn: 0, afterKong: 0, claim: 0 }, (fn) => fn(), () => 0)
    const action = await controller.requestClaim(makeClaimCtx(['east', 'east'], { canGang: false, tile: 'east' }))
    expect(action).toEqual({ kind: 'pass' })
  })

  it('使用 claim 延迟', async () => {
    const calls: number[] = []
    const scheduler = (fn: () => void, ms: number) => { calls.push(ms); fn() }
    const controller = new AiController({ turn: 650, afterKong: 300, claim: 500 }, scheduler)
    await controller.requestClaim(makeClaimCtx(['east', 'east', 'east', 'm1'], { canGang: true }))
    expect(calls).toEqual([500])
  })
})

describe('AiController.requestRobKong', () => {
  it('当前 AI 能抢必抢', async () => {
    const controller = new AiController()
    const action = await controller.requestRobKong(makeRobCtx())
    expect(action).toBe('win')
  })

  it('无额外延迟', async () => {
    const calls: number[] = []
    const scheduler = (fn: () => void, ms: number) => { calls.push(ms); fn() }
    const controller = new AiController({ turn: 650, afterKong: 300, claim: 500 }, scheduler)
    await controller.requestRobKong(makeRobCtx())
    // requestRobKong 应该不调用 scheduler（无延迟）
    expect(calls).toEqual([])
  })
})

describe('AiController.onDiscarded / reset', () => {
  it('onDiscarded 和 reset 为无操作', () => {
    const controller = new AiController()
    expect(() => controller.onDiscarded?.()).not.toThrow()
    expect(() => controller.reset?.()).not.toThrow()
  })
})
