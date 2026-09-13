// 路线收窄推广到普通 AI 座（2026-09-14）：清一色 / 混一色 / 碰碰胡 三条线的判定、路线感知的副露策略、
// 以及用户明确关心的两条边界：
//   ① **起手特别好时路线要被认出来并承诺**（不能因为"不是任意听"就放弃）；
//   ② **已经能胡成大牌时不能放弃胡**（路线收益 < 立即胡 × declineWinRatio 时保留"胡"）。
import { describe, expect, it } from 'vitest'
import {
  BLOOD_FLOW_BIG_HAND_ROUTE, BLOOD_FLOW_BIG_HAND_ROUTE_WIDE,
  claimKeepsRoute, detectBigHandRoute, narrowActionsToRoute, routePayoff,
} from './bigHandRoute'
import { BLOOD_FLOW_AI } from './config'
import { decideBloodFlowActionEv } from './ai'
import type { BloodFlowSeatView } from './seatView'
import type { Meld, TileType } from '../../../core/contracts/types'

const WIDE = BLOOD_FLOW_BIG_HAND_ROUTE_WIDE
const OFF = BLOOD_FLOW_BIG_HAND_ROUTE

/** 清一色好起手：11 张万子 + 2 张字牌（够不到九莲的 12 张门槛，所以只会命中清一色）。 */
const FLUSH_START: TileType[] = ['m1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm8', 'm9', 'east', 'north']
/** 混一色：10 张筒子 + 3 张字牌（字牌 3 张已超过清一色的异色上限 2，所以只会命中混一色）。 */
const MIXED_START: TileType[] = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p1', 'east', 'south', 'west']
/** 碰碰胡：3 刻 + 2 对。 */
const TRIPLETS_START: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'p5', 'p5', 'p5', 's7', 's7', 'east', 'east']
/** 普通散手：任何路线都不成立。 */
const PLAIN: TileType[] = ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p3', 'p4', 'p5', 's7', 's8', 'east', 'east']

function view(hand: TileType[], options: {
  win?: number; ownActions?: BloodFlowSeatView['ownActions']; claimTile?: TileType; wallCount?: number
} = {}): BloodFlowSeatView {
  const ownActions = options.ownActions ?? [
    ...(options.win ? [{ kind: 'win' } as const] : []),
    { kind: 'pass' } as const,
    ...hand.map((_, index) => ({ kind: 'discard', index }) as const),
  ]
  const claim = options.claimTile !== undefined
  return {
    authorityEpoch: 'wide', roundId: `r-${hand.join('')}-${options.win ?? 0}-${options.claimTile ?? 'turn'}`, seat: 0,
    wallCount: options.wallCount ?? 40, flipTile: 'red', jokers: ['white'], version: 1,
    players: [0, 1, 2, 3].map(index => ({
      seat: index, score: 2000, hand: index === 0 ? [...hand] : [], discards: [], melds: [], concealedTileCount: 13,
      drawnTileIndex: index === 0 ? hand.length - 1 : -1,
    })),
    public: { status: 'playing', seats: [0, 1, 2, 3].map(() => ({ winCount: 0, locked: false })), batches: [] },
    ownActions, actionEvents: [],
    ownScore: options.win
      ? { items: [{ id: 'pure-suit', label: '清一色', weight: 8 }], patternMultiplier: 8, eventMultiplier: 1, finalMultiplier: 16, paymentPerPayer: options.win }
      : undefined,
    window: {
      id: 'w', version: 1, kind: claim ? 'meld' : 'turn', deadlineAt: 0, opensAt: 0,
      source: { id: 's', kind: claim ? 'discard' : 'draw', tile: options.claimTile ?? hand[hand.length - 1], seat: claim ? 3 : 0 },
    },
  } as unknown as BloodFlowSeatView
}

describe('三条新路线的判定门槛', () => {
  it('清一色：同色 ≥10 张且异色+字牌 ≤2 → 成立；差一点不成立', () => {
    expect(detectBigHandRoute(FLUSH_START, [], ['white'], WIDE)?.id).toBe('pureSuit')
    // 只有 9 张万子 → 不成立
    const fewer: TileType[] = ['m1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'east', 'north', 'west', 'red']
    expect(detectBigHandRoute(fewer, [], ['white'], WIDE)?.id).not.toBe('pureSuit')
    // 异色 3 张（超过上限 2）→ 不成立
    const foreign: TileType[] = [...FLUSH_START.slice(0, 10), 'p1', 'p2', 'p3']
    expect(detectBigHandRoute(foreign, [], ['white'], WIDE)).toBeNull()
  })

  it('混一色：同色 ≥10 张 + 字牌，且另门数牌 ≤1', () => {
    const route = detectBigHandRoute(MIXED_START, [], ['white'], WIDE)!
    expect(route.id).toBe('mixedSuit')
    expect(route.mainSuit).toBe('p')
    // 另门数牌 2 张 → 混一色也不成立
    const two: TileType[] = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p1', 'm2', 'm6', 'east']
    expect(detectBigHandRoute(two, [], ['white'], WIDE)).toBeNull()
  })

  it('两条线同时成立时取番值更高/更接近的那条：11 张一门 + 2 字牌 → 清一色（8 番）而非混一色（4 番）', () => {
    expect(detectBigHandRoute(FLUSH_START, [], ['white'], WIDE)?.id).toBe('pureSuit')
  })

  it('碰碰胡：对/刻单位 ≥4 且无吃；有吃副露则不成立', () => {
    const route = detectBigHandRoute(TRIPLETS_START, [], ['white'], WIDE)!
    expect(route.id).toBe('allTriplets')
    const chi: Meld[] = [{ type: 'chi', tile: 'm2', tiles: ['m1', 'm2', 'm3'] }]
    expect(detectBigHandRoute(TRIPLETS_START, chi, ['white'], WIDE)).toBeNull()
  })

  it('字牌副露：混一色允许（字牌是它的一部分），清一色不允许', () => {
    const eastPeng: Meld[] = [{ type: 'peng', tile: 'east', tiles: ['east', 'east', 'east'] }]
    const hand: TileType[] = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p1', 'east', 'south', 'west']
    // 手里 10 张筒子 + 字牌，且已碰东 → 混一色成立
    expect(detectBigHandRoute(hand, eastPeng, ['white'], WIDE)?.id).toBe('mixedSuit')
    // 同一副露下清一色不成立（字牌副露破了清一色）
    const pureHand: TileType[] = ['p1', 'p1', 'p2', 'p2', 'p3', 'p3', 'p4', 'p4', 'p5', 'p5', 'p6', 'p6', 'p7']
    const route = detectBigHandRoute(pureHand, eastPeng, ['white'], WIDE)
    expect(route?.id).not.toBe('pureSuit')
  })

  it('默认配置（只启用十三幺/九莲）下，三条新路线都不成立 —— 现有行为不变', () => {
    expect(detectBigHandRoute(FLUSH_START, [], ['white'], OFF)).toBeNull()
    expect(detectBigHandRoute(TRIPLETS_START, [], ['white'], OFF)).toBeNull()
  })
})

describe('路线感知的副露策略（不再"一律撤副露"）', () => {
  const route = (hand: TileType[]) => detectBigHandRoute(hand, [], ['white'], WIDE)!
  const wildcards = new Set<TileType>(['white'])

  it('碰碰胡：留碰/杠、撤吃', () => {
    const target = route(TRIPLETS_START)
    expect(claimKeepsRoute(target, { kind: 'peng', tiles: ['m1', 'm1', 'm1'] }, 'm1', wildcards)).toBe(true)
    expect(claimKeepsRoute(target, { kind: 'gang', tiles: ['m1'] }, 'm1', wildcards)).toBe(true)
    expect(claimKeepsRoute(target, { kind: 'chi', tiles: ['m1', 'm2', 'm3'] }, 'm3', wildcards)).toBe(false)
  })

  it('清一色：只留守门花色的吃碰杠；混一色还允许字牌', () => {
    const flush = route(FLUSH_START)
    expect(flush.mainSuit).toBe('m')
    expect(claimKeepsRoute(flush, { kind: 'peng', tiles: ['m1', 'm1', 'm1'] }, 'm1', wildcards)).toBe(true)
    expect(claimKeepsRoute(flush, { kind: 'chi', tiles: ['m1', 'm2', 'm3'] }, 'm3', wildcards)).toBe(true)
    expect(claimKeepsRoute(flush, { kind: 'peng', tiles: ['p9', 'p9', 'p9'] }, 'p9', wildcards)).toBe(false)
    const mixed = route(MIXED_START)
    expect(claimKeepsRoute(mixed, { kind: 'peng', tiles: ['east', 'east', 'east'] }, 'east', wildcards)).toBe(true)
  })

  it('门清路线（十三幺/九莲）仍然一律撤副露', () => {
    const orphans: TileType[] = ['m1', 'm9', 'p1', 'p9', 's1', 's9', 'east', 'south', 'west', 'north', 'red', 'green', 'white', 'm5']
    const target = route(orphans)
    expect(target.id).toBe('thirteenOrphans')
    expect(claimKeepsRoute(target, { kind: 'peng', tiles: ['m1'] }, 'm1', wildcards)).toBe(false)
    expect(claimKeepsRoute(target, { kind: 'gang', tiles: ['m1'] }, 'm1', wildcards)).toBe(false)
  })
})

describe('用户关心的边界①：起手特别好时要认出来并承诺', () => {
  const actions = (hand: TileType[]) => [{ kind: 'pass' } as const, ...hand.map((_, index) => ({ kind: 'discard', index }) as const)]

  it('11 张一门（清一色在路上）→ 路线成立且承诺（收窄后仍有牌可打，且都保路线）', () => {
    const narrowed = narrowActionsToRoute(FLUSH_START, [], ['white'], actions(FLUSH_START), {
      config: WIDE, basePoints: 10, immediateWinPayment: 0, wallCount: 40, scoreDeficit: 0,
    })
    expect(narrowed.route?.id).toBe('pureSuit')
    expect(narrowed.collapsed).toBe(true)
    const discards = narrowed.actions.filter(action => action.kind === 'discard')
    expect(discards.length).toBeGreaterThan(0)
    // 打掉字牌/异色牌都保路线；打掉万子里的关键张会掉路线（清一色要求 ≥10 张同色）
    const keepsSuitCard = (index: number) => narrowed.actions.some(action => action.kind === 'discard' && action.index === index)
    expect(keepsSuitCard(11)).toBe(true)                    // east（该打掉）
    expect(keepsSuitCard(0)).toBe(false)                    // m1（打掉就只剩 10 张，进度下降 → 被撤）
  })

  it('碰碰胡好起手同样成立且承诺', () => {
    const narrowed = narrowActionsToRoute(TRIPLETS_START, [], ['white'], actions(TRIPLETS_START), {
      config: WIDE, basePoints: 10, immediateWinPayment: 0, wallCount: 40, scoreDeficit: 0,
    })
    expect(narrowed.route?.id).toBe('allTriplets')
    expect(narrowed.collapsed).toBe(true)
  })
})

describe('用户关心的边界②：已经能胡的大牌不能被放弃', () => {
  const KONG = { ...BLOOD_FLOW_AI, bigHandRoute: WIDE }
  const winActions = [{ kind: 'win' } as const, { kind: 'pass' } as const]

  it('清一色硬胡（160 点）> 路线收益的一半 → 保留"胡"', () => {
    expect(routePayoff(detectBigHandRoute(FLUSH_START, [], ['white'], WIDE)!, 10)).toBe(160)
    const decision = decideBloodFlowActionEv(view(FLUSH_START, { win: 160, ownActions: [...winActions] }), KONG)
    expect(decision).toEqual({ kind: 'win' })
  })

  it('只有 10 点的鸡胡（远低于清一色收益）→ 承诺路线、放掉小胡', () => {
    const decision = decideBloodFlowActionEv(view(FLUSH_START, { win: 10, ownActions: [...winActions] }), KONG)
    expect(decision).not.toEqual({ kind: 'win' })
  })

  it('中局 40 点这一档：路线关闭时胡、开启时承诺（同一手牌的直接对照）', () => {
    const OFF_AI = { ...BLOOD_FLOW_AI, bigHandRoute: OFF }
    const input = () => view(FLUSH_START, { win: 40, ownActions: [...winActions], wallCount: 40 })
    expect(decideBloodFlowActionEv(input(), OFF_AI)).toEqual({ kind: 'win' })
    expect(decideBloodFlowActionEv(input(), KONG)).not.toEqual({ kind: 'win' })
  })
})

describe('普通 AI 座的接线（mode=bot）', () => {
  const KONG = { ...BLOOD_FLOW_AI, bigHandRoute: WIDE }

  it('清一色路线成立时，别人打异色牌不去碰（候选层直接撤掉碰）', () => {
    const hand: TileType[] = [...FLUSH_START.slice(0, 11), 'p9', 'p9']
    const claimView = view(hand, { claimTile: 'p9', ownActions: [{ kind: 'pass' } as const, { kind: 'peng' } as const] })
    expect(decideBloodFlowActionEv(claimView, KONG)).toEqual({ kind: 'pass' })
    // 同色牌照碰（清一色允许同色副露）
    const inSuit: TileType[] = ['m1', 'm1', ...FLUSH_START.slice(2), 'p9', 'p9'].slice(0, 13) as TileType[]
    const inSuitView = view(inSuit, { claimTile: 'm1', ownActions: [{ kind: 'pass' } as const, { kind: 'peng' } as const] })
    expect(decideBloodFlowActionEv(inSuitView, KONG)).toEqual({ kind: 'peng' })
  })

  it('路线关闭时同样的窗口照常碰（行为不变）', () => {
    const hand: TileType[] = [...FLUSH_START.slice(0, 11), 'p9', 'p9']
    const claimView = view(hand, { claimTile: 'p9', ownActions: [{ kind: 'pass' } as const, { kind: 'peng' } as const] })
    expect(decideBloodFlowActionEv(claimView, { ...BLOOD_FLOW_AI, bigHandRoute: OFF })).toEqual({ kind: 'peng' })
  })

  it('无路线的手牌不受影响（收窄不会误伤普通局面）', () => {
    const plain = decideBloodFlowActionEv(view(PLAIN), KONG)
    const off = decideBloodFlowActionEv(view(PLAIN), { ...BLOOD_FLOW_AI, bigHandRoute: OFF })
    expect(plain).toEqual(off)
  })
})
