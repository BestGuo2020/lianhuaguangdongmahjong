// 第 3 步（2026-09-13）：开杠决策的"自手牌型损失"。
//
//   开杠价值 = 杠收益 − 防守风险 − 自手牌型损失（见 kongValue.ts）
//   自手牌型损失 = ① 七对/豪华七对潜力损失 + ② 明杠破坏门清 + ③ 向听恶化
//
// 这条规则**不是**"检测到七对就禁杠"：路线越接近（对子越多、越接近四张）扣得越多；
// 路线还没成形（对子不够，sevenPairsPotential = 0）时扣减为 0，该杠照杠。
import { describe, expect, it } from 'vitest'
import type { Meld, TileType } from '../../../core/contracts/types'
import { applyActionPriority, bloodFlowAiActions, bloodFlowKongValue, decideBloodFlowActionEv } from './ai'
import { BLOOD_FLOW_AI, BLOOD_FLOW_KONG_VALUE } from './config'
import { kongCandidateValue, kongGain, kongSelfLoss, sevenPairsRouteValue, type KongValueInput } from './kongValue'
import type { BloodFlowSeatView } from './seatView'

const JOKERS: TileType[] = ['red']

/** 和别人打出的 m3 能大明杠：手里有 3 张 m3 + 4 对 + 2 散张（七对只差 2 对，豪华七对差"四张"）。 */
const LUXURY_ROUTE: TileType[] = ['m3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 's3', 's3', 'p7', 's8']
/** 七对路线已废：只有 3 对，sevenPairsPotential = 0。 */
const SEVEN_PAIRS_DEAD: TileType[] = ['m5', 'm5', 'm5', 'm1', 'm1', 'm2', 'm2', 'p4', 'p5', 'p6', 's7', 's9', 'east']
/** 门清听牌：四副面子 + 单张 east，明杠 m5 会造出一副露，门清（1 番）随之消失。 */
const CONCEALED_TENPAI: TileType[] = ['m5', 'm5', 'm5', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east']

function claimView(hand: readonly TileType[], melds: Meld[] = [], discards: TileType[] = [], tile: TileType = 'm3'): BloodFlowSeatView {
  const players = [0, 1, 2, 3].map(index => ({
    seat: index, score: 2000, hand: index === 0 ? [...hand] : [], discards: index === 0 ? [...discards] : [],
    melds: index === 0 ? melds : [], concealedTileCount: 13,
  }))
  return {
    seat: 0, wallCount: 40, flipTile: 'red', jokers: JOKERS, version: 1, players,
    public: { seats: [0, 1, 2, 3].map(() => ({ winCount: 0, locked: false })), batches: [] },
    ownActions: [{ kind: 'pass' }, { kind: 'gang' }, { kind: 'peng' }], actionEvents: [],
    window: { id: 'w', version: 1, kind: 'meld', deadlineAt: 0, opensAt: 0, source: { id: 's', kind: 'discard', tile, seat: 3 } },
  } as unknown as BloodFlowSeatView
}

function turnView(hand: readonly TileType[], melds: Meld[] = [], ownActions?: BloodFlowSeatView['ownActions']): BloodFlowSeatView {
  const players = [0, 1, 2, 3].map(index => ({
    seat: index, score: 2000, hand: index === 0 ? [...hand] : [], discards: [], melds: index === 0 ? melds : [],
    concealedTileCount: 13,
  }))
  return {
    seat: 0, wallCount: 40, flipTile: 'red', jokers: JOKERS, version: 1, players,
    public: { seats: [0, 1, 2, 3].map(() => ({ winCount: 0, locked: false })), batches: [] },
    ownActions: ownActions ?? hand.map((_, index) => ({ kind: 'discard', index }) as const), actionEvents: [],
    window: { id: 'w', version: 1, kind: 'turn', deadlineAt: 0, opensAt: 0,
      source: { id: 's', kind: 'draw', tile: hand[hand.length - 1], seat: 0 } },
  } as unknown as BloodFlowSeatView
}

describe('① 豪华七对/七对路线成立 → 不杠', () => {
  it('手上三张 + 四对（只差两对，且已有刻子可成四张）→ 明杠净值为负，AI 过', () => {
    const input: KongValueInput = { kind: 'discard-gang', hand: LUXURY_ROUTE, melds: [], jokers: JOKERS, tile: 'm3' }
    const value = kongCandidateValue({ ...input, config: BLOOD_FLOW_KONG_VALUE })
    expect(value.gain).toBe(kongGain('discard-gang'))
    expect(value.selfLoss.sevenPairs).toBeGreaterThan(value.gain)
    expect(value.net).toBeLessThan(0)
    expect(value.selfLoss.reasons.join()).toContain('七对')

    // 决策层：血流 EV 路径确实选择"过"（候选里没有碰 → 过），不是硬编码禁杠。
    const view = claimView(LUXURY_ROUTE)
    expect(bloodFlowAiActions(view, BLOOD_FLOW_AI).some(action => action.kind === 'gang')).toBe(true)
    expect(decideBloodFlowActionEv(view, BLOOD_FLOW_AI)).toEqual({ kind: 'pass' })
  })

  it('路线越接近扣得越多（对子从 4 对走到 5 对，自手牌型损失单调上升）', () => {
    const fewer = kongSelfLoss({ kind: 'discard-gang', hand: ['m3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 'p7', 's8', 's9', 'east'], melds: [], jokers: JOKERS, tile: 'm3' })
    const more = kongSelfLoss({ kind: 'discard-gang', hand: LUXURY_ROUTE, melds: [], jokers: JOKERS, tile: 'm3' })
    expect(more.sevenPairs).toBeGreaterThan(fewer.sevenPairs)
    // 路线价值随接近度上升，且任何副露都会让它归零（七对不可能有副露）。
    const melded: Meld[] = [{ type: 'peng', tile: 'm1', tiles: ['m1', 'm1', 'm1'] }]
    expect(sevenPairsRouteValue(LUXURY_ROUTE, [], JOKERS)).toBeGreaterThan(0)
    expect(sevenPairsRouteValue(LUXURY_ROUTE, melded, JOKERS)).toBe(0)
  })

  it('四张在手（暗杠会拆掉豪华七对）→ 不暗杠', () => {
    const hand: TileType[] = ['m3', 'm3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 's3', 's3', 'p7', 's8']
    const view = turnView(hand, [], [...hand.map((_, index) => ({ kind: 'discard', index }) as const), { kind: 'concealed-kong', tile: 'm3' }])
    const value = bloodFlowKongValue(view, { kind: 'concealed-kong', tile: 'm3' }, BLOOD_FLOW_AI)!
    expect(value.selfLoss.sevenPairs).toBeGreaterThan(value.gain)
    expect(decideBloodFlowActionEv(view, BLOOD_FLOW_AI)?.kind).toBe('discard')
  })
})

describe('② 七对路线已废 → 仍杠', () => {
  it('只有三对（潜力为 0）→ 明杠净值仍为正，AI 照杠', () => {
    const value = kongCandidateValue({ kind: 'discard-gang', hand: SEVEN_PAIRS_DEAD, melds: [], jokers: JOKERS, tile: 'm5' })
    expect(value.selfLoss.sevenPairs).toBe(0)
    expect(value.net).toBeGreaterThan(0)
    expect(decideBloodFlowActionEv(claimView(SEVEN_PAIRS_DEAD, [], [], 'm5'), BLOOD_FLOW_AI)).toEqual({ kind: 'gang' })
  })

  it('已经副露的牌（七对必死）→ 补杠仍按净值走，不会被"路线损失"误拦', () => {
    const melds: Meld[] = [{ type: 'peng', tile: 'm5', tiles: ['m5', 'm5', 'm5'] }]
    const hand: TileType[] = ['m5', 'm1', 'm4', 'p7', 's2']
    const loss = kongSelfLoss({ kind: 'added-kong', hand, melds, jokers: JOKERS, meldIndex: 0 })
    expect(loss.sevenPairs).toBe(0)
    expect(loss.concealedHand).toBe(0)
    expect(kongGain('added-kong')).toBeGreaterThan(0)
  })
})

describe('③ 明杠破坏门清 → 计入损失', () => {
  const input: KongValueInput = { kind: 'discard-gang', hand: CONCEALED_TENPAI, melds: [], jokers: JOKERS, tile: 'm5' }

  it('门清听牌开明杠：门清（1 番独立番种）按接近度折价后计入扣减', () => {
    const value = kongCandidateValue(input)
    expect(value.selfLoss.concealedHand).toBeGreaterThan(0)
    expect(value.selfLoss.reasons.join()).toContain('门清')
    expect(value.net).toBeCloseTo(value.gain - value.risk - value.selfLoss.total, 6)
    expect(value.net).toBeLessThan(value.gain)
  })

  it('已经有副露的牌不算这项损失（门清早就没了）', () => {
    const melds: Meld[] = [{ type: 'peng', tile: 'east', tiles: ['east', 'east', 'east'] }]
    const value = kongCandidateValue({ ...input, melds })
    expect(value.selfLoss.concealedHand).toBe(0)
    expect(value.selfLoss.total).toBeLessThan(kongCandidateValue(input).selfLoss.total)
  })

  it('门清的损失不足时仍照杠（损失是"计入比较"，不是"一律禁杠"）', () => {
    expect(kongCandidateValue(input).net).toBeGreaterThan(0)
    expect(decideBloodFlowActionEv(claimView(CONCEALED_TENPAI, [], [], 'm5'), BLOOD_FLOW_AI)).toEqual({ kind: 'gang' })
  })
})

describe('补杠的抢杠风险按公开张数计价', () => {
  const melds: Meld[] = [{ type: 'peng', tile: 'm5', tiles: ['m5', 'm5', 'm5'] }]
  const hand: TileType[] = ['m5', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9']
  const base: KongValueInput = { kind: 'added-kong', hand, melds, jokers: JOKERS, meldIndex: 0, tile: 'm5' }

  it('该牌完全未现时风险最高，公开越多风险越低', () => {
    const unseen = kongCandidateValue({ ...base, publicTiles: [] })
    const once = kongCandidateValue({ ...base, publicTiles: ['m5'] })
    const twice = kongCandidateValue({ ...base, publicTiles: ['m5', 'm5'] })
    expect(unseen.risk).toBeGreaterThan(once.risk)
    expect(once.risk).toBeGreaterThan(twice.risk)
  })
})

describe('④ kong-priority 臂：开杠价值没过关时不撤"胡"候选', () => {
  /** 已经成立的豪华七对：实体四张 m3 + 五对。手上四张 → 引擎必然同时给出暗杠候选。 */
  const LUXURY_WIN: TileType[] = ['m3', 'm3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 's3', 's3', 'p7', 'p7']

  function winningView(): { view: BloodFlowSeatView; actions: BloodFlowSeatView['ownActions'] } {
    const hand = LUXURY_WIN
    const actions = [
      { kind: 'win' }, { kind: 'pass' },
      ...hand.map((_, index) => ({ kind: 'discard', index }) as const),
      { kind: 'concealed-kong', tile: 'm3' } as const,
    ] as BloodFlowSeatView['ownActions']
    const view = turnView(hand, [], actions)
    view.ownScore = { paymentPerPayer: 480, source: 'self-draw' } as BloodFlowSeatView['ownScore']
    return { view, actions }
  }

  it('自摸豪华七对时保留胡候选（旧口径会撤掉胡候选 —— kong 臂豪华七对 0 次的根因）', () => {
    const { view, actions } = winningView()
    const legacy = { ...BLOOD_FLOW_AI, kongValue: { ...BLOOD_FLOW_KONG_VALUE, mode: 'off' as const } }

    // 旧口径：只要存在杠候选就撤掉"胡"（"胡最低"），胡牌张会被打掉。
    expect(applyActionPriority(view, actions, legacy, 'kong-priority').some(action => action.kind === 'win')).toBe(false)
    // 新口径：杠候选净值（= 杠收益 − 手上四张拆掉豪华七对的损失）为负 → 胡压不过 → 保留胡候选。
    const kept = applyActionPriority(view, actions, BLOOD_FLOW_AI, 'kong-priority')
    expect(kept.some(action => action.kind === 'win')).toBe(true)
    expect(kept.some(action => action.kind === 'concealed-kong')).toBe(true)
    // standard 开关下本来就不收窄（回归保证）。
    expect(applyActionPriority(view, actions, legacy, 'standard').some(action => action.kind === 'win')).toBe(true)
  })

  it('自摸豪华七对时血流 EV 决策确实选择胡', () => {
    const { view } = winningView()
    expect(decideBloodFlowActionEv(view, BLOOD_FLOW_AI)).toEqual({ kind: 'win' })
  })
})
