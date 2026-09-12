// 真·大牌路线（v4）：判定、收窄与不变式。
// 关键不变式：路线成立时**任何**被交给 LLM 的弃牌都不会让路线倒退——所以"模型不做大牌"不再是变量。
import { describe, expect, it } from 'vitest'
import {
  BLOOD_FLOW_BIG_HAND_ROUTE, detectBigHandRoute, narrowActionsToRoute, routeKeepsProgress, routePayoff,
} from './bigHandRoute'
import { buildBloodFlowDecisionInput } from '../../../llm/bloodFlowDecisionInput'
import { BLOOD_FLOW_AI } from './config'
import { bloodFlowAiActions } from './ai'
import type { BloodFlowSeatView } from './seatView'
import type { TileType } from '../../../core/contracts/types'

const ROUTE_ON = { ...BLOOD_FLOW_AI, bigHandRoute: { ...BLOOD_FLOW_BIG_HAND_ROUTE, mode: 'llm' as const } }

/** 13 种幺九字牌 + 一张闲牌：本身已是十三烂胡牌形，改张打闲牌即十三幺 13 面听。 */
const ORPHANS13: TileType[] = ['m1', 'm9', 'p1', 'p9', 's1', 's9', 'east', 'south', 'west', 'north', 'red', 'green', 'white', 'm5']
/** 11 种幺九 + 三张普通牌：还差 2 种。 */
const ORPHANS11: TileType[] = ['m1', 'm9', 'p9', 's1', 's9', 'east', 'south', 'west', 'north', 'red', 'green', 'm3', 'm4', 'm5']
/** 九莲形态：筒子 1112345678999 + 一张字牌。 */
const NINEGATES: TileType[] = ['p1', 'p1', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p9', 'p9', 'east']
/** 普通牌（无路线）。 */
const PLAIN: TileType[] = ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p3', 'p4', 'p5', 's7', 's8', 'east', 'east', 'north']

function view(hand: TileType[], options: { win?: number; claim?: boolean } = {}): BloodFlowSeatView {
  const ownActions: unknown[] = options.claim
    ? [{ kind: 'pass' }, { kind: 'peng' }]
    : [...(options.win ? [{ kind: 'win' }] : []), { kind: 'pass' }, ...hand.map((_, index) => ({ kind: 'discard', index }))]
  return {
    authorityEpoch: 'p', roundId: `r-${hand.join('')}-${options.win ?? 0}-${options.claim ? 'c' : 't'}`, seat: 0, wallCount: 30,
    flipTile: 'red', jokers: ['white'], version: 1,
    players: [0, 1, 2, 3].map(index => ({
      seat: index, score: 2000, hand: index === 0 ? [...hand] : [], discards: [], melds: [], concealedTileCount: 13,
      drawnTileIndex: index === 0 ? hand.length - 1 : -1,
    })),
    public: { status: 'playing', seats: [0, 1, 2, 3].map(() => ({ winCount: 0, locked: false })), batches: [] },
    ownActions, actionEvents: [],
    ownScore: options.win
      ? { items: [{ id: 'shiSanLan', label: '十三烂', weight: 2 }], patternMultiplier: 2, eventMultiplier: 2, finalMultiplier: 4, paymentPerPayer: options.win }
      : undefined,
    window: { id: 'w', version: 3, kind: options.claim ? 'meld' : 'turn', deadlineAt: Date.now() + 15000, opensAt: 0, source: { id: 's', kind: options.claim ? 'discard' : 'draw', tile: hand[hand.length - 1], seat: 0 } },
  } as unknown as BloodFlowSeatView
}

describe('大牌路线判定', () => {
  it('十三幺：13 种 = 路线(1.0)、12 种 = 路线、11 种 = 不成立（收紧后门槛 12）', () => {
    const config = { ...BLOOD_FLOW_BIG_HAND_ROUTE, mode: 'llm' as const }
    const full = detectBigHandRoute(ORPHANS13, [], ['white'], config)!
    expect(full.id).toBe('thirteenOrphans')
    expect(full.progress).toBeCloseTo(1, 5)
    expect(full.need).toEqual([])
    // 12 种（去掉白板）仍成立
    expect(detectBigHandRoute(ORPHANS13.filter(tile => tile !== 'white'), [], ['white'], config)?.id).toBe('thirteenOrphans')
    // 11 种不再成立（收紧：接近完成才承诺）
    expect(detectBigHandRoute(ORPHANS11, [], ['white'], config)).toBeNull()
    expect(detectBigHandRoute(PLAIN, [], ['white'], config)).toBeNull()
    expect(detectBigHandRoute(ORPHANS13, [], ['white'], BLOOD_FLOW_BIG_HAND_ROUTE)).toBeNull()  // 默认关闭
  })

  it('时机门槛：牌墙不足且不落后时不承诺；牌墙充足或落后 300+ 时承诺', () => {
    const config = { ...BLOOD_FLOW_BIG_HAND_ROUTE, mode: 'llm' as const }
    const actions = [{ kind: 'win' }, { kind: 'pass' }, ...ORPHANS13.map((_, index) => ({ kind: 'discard', index }))]
    const base = { config, basePoints: 10, immediateWinPayment: 80 }
    // 残局（墙 10）且不落后 → 不承诺（保留"胡"）
    const late = narrowActionsToRoute(ORPHANS13, [], ['white'], actions, { ...base, wallCount: 10, scoreDeficit: 0 })
    expect(late.route).not.toBeNull()
    expect(late.collapsed).toBe(false)
    // 牌墙充足（30）→ 承诺（撤掉"胡"）
    const early = narrowActionsToRoute(ORPHANS13, [], ['white'], actions, { ...base, wallCount: 30, scoreDeficit: 0 })
    expect(early.collapsed).toBe(true)
    expect(early.actions.some(action => action.kind === 'win')).toBe(false)
    // 残局但落后 400 分 → 允许承诺（需要大牌翻盘）
    const behind = narrowActionsToRoute(ORPHANS13, [], ['white'], actions, { ...base, wallCount: 10, scoreDeficit: 400 })
    expect(behind.collapsed).toBe(true)
  })

  it('九莲：一门凑齐 1-9 即成立（手里的字牌不影响判定，它本来就该打掉）', () => {
    const route = detectBigHandRoute(NINEGATES, [], ['white'], { ...BLOOD_FLOW_BIG_HAND_ROUTE, mode: 'llm' })!
    expect(route.id).toBe('nineGates')
    expect(route.progress).toBeCloseTo(1, 5)
  })

  it('有副露时路线不成立（十三幺/九莲都要求门清）', () => {
    const meld = { type: 'peng', tiles: ['m5', 'm5', 'm5'], concealed: false } as never
    expect(detectBigHandRoute([...ORPHANS11, 'm5'], [meld], ['white'], { ...BLOOD_FLOW_BIG_HAND_ROUTE, mode: 'llm' })).toBeNull()
  })

  it('routeKeepsProgress：打闲牌保持，打掉路线需要的牌则不保持（无精牌时）', () => {
    const config = { ...BLOOD_FLOW_BIG_HAND_ROUTE, mode: 'llm' as const }
    // 不带白板/精牌，避免"精牌顶替"掩盖进度下降
    const hand: TileType[] = ['m1', 'm9', 'p1', 'p9', 's1', 's9', 'east', 'south', 'west', 'north', 'red', 'green', 'm5', 'm6']
    const route = detectBigHandRoute(hand, [], [], config)!
    expect(route.id).toBe('thirteenOrphans')
    const dropJunk = hand.filter((_, index) => index !== 12)          // 打掉 m5
    const dropOrphan = hand.filter((_, index) => index !== 0)         // 打掉 m1（路线需要的牌）
    expect(routeKeepsProgress(dropJunk, [], [], route, config)).toBe(true)
    expect(routeKeepsProgress(dropOrphan, [], [], route, config)).toBe(false)

    // 有精牌时：打掉一种幺九不算破坏（精牌能顶替）——这是刻意的行为
    const withJoker = detectBigHandRoute(ORPHANS13, [], ['white'], config)!
    expect(routeKeepsProgress(ORPHANS13.filter((_, index) => index !== 0), [], ['white'], withJoker, config)).toBe(true)
  })

  it('路线完成收益高于立即胡（十六倍级硬胡 320 点 vs 十三烂 80 点）', () => {
    const route = detectBigHandRoute(ORPHANS13, [], ['white'], { ...BLOOD_FLOW_BIG_HAND_ROUTE, mode: 'llm' })!
    expect(routePayoff(route, 10)).toBe(320)
    expect(routePayoff(route, 10)).toBeGreaterThan(80 * BLOOD_FLOW_BIG_HAND_ROUTE.declineWinRatio)
  })
})

describe('候选层收窄（只作用于 LLM）', () => {
  it('开启后：无"胡"候选、无碰吃杠、弃牌只剩不掉路线的牌', () => {
    const built = buildBloodFlowDecisionInput(view(ORPHANS13, { win: 80 }), 'route-win', {}, ROUTE_ON)
    const kinds = built.candidates.map(candidate => candidate.action.kind)
    expect(built.collapsedByRoute).toBe(true)
    expect(kinds).not.toContain('win')
    expect(kinds).not.toContain('peng')
    expect(kinds.every(kind => kind === 'discard' || kind === 'pass')).toBe(true)
    // 不变式：候选里每一张弃牌打出去都还在路线上
    const config = { ...BLOOD_FLOW_BIG_HAND_ROUTE, mode: 'llm' as const }
    const route = detectBigHandRoute(ORPHANS13, [], ['white'], config)!
    for (const candidate of built.candidates) {
      const action = candidate.action
      if (action.kind !== 'discard') continue
      const after = ORPHANS13.filter((_, index) => index !== action.index)
      expect(routeKeepsProgress(after, [], ['white'], route, config)).toBe(true)
    }
  })

  it('立即胡远高于路线价值时仍然保留"胡"（不能为了大牌无脑放走大分）', () => {
    const built = buildBloodFlowDecisionInput(view(ORPHANS13, { win: 2000 }), 'route-bigwin', {}, ROUTE_ON)
    expect(built.candidates.map(candidate => candidate.action.kind)).toContain('win')
  })

  it('默认关闭（mode off）：候选与现状完全一致，仍有"胡"与碰', () => {
    const built = buildBloodFlowDecisionInput(view(ORPHANS13, { win: 80 }), 'route-off', {}, BLOOD_FLOW_AI)
    expect(built.bigHandRoute).toBeNull()
    expect(built.candidates.map(candidate => candidate.action.kind)).toContain('win')
    expect(buildBloodFlowDecisionInput(view(ORPHANS11, { claim: true }), 'route-off-claim', {}, BLOOD_FLOW_AI)
      .candidates.map(candidate => candidate.action.kind)).toContain('peng')
  })

  it('路线成立时碰/杠候选被撤掉（claim 窗口只剩过）', () => {
    const built = buildBloodFlowDecisionInput(view(ORPHANS13, { claim: true }), 'route-claim', {}, ROUTE_ON)
    expect(built.candidates.map(candidate => candidate.action.kind)).toEqual(['pass'])
    expect(built.collapsedByRoute).toBe(true)
  })

  it('无路线的手牌不受影响（收窄不会误伤普通局面）', () => {
    const built = buildBloodFlowDecisionInput(view(PLAIN), 'route-plain', {}, ROUTE_ON)
    const plain = buildBloodFlowDecisionInput(view(PLAIN), 'route-plain2', {}, BLOOD_FLOW_AI)
    expect(built.collapsedByRoute).toBe(false)
    expect(built.candidates.length).toBe(plain.candidates.length)
  })
})
