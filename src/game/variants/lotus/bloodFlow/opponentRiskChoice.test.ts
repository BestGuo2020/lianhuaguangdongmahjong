// 档位版是否真的改变引擎选择：同一局面下 off 与 tier 必须选出不同的弃牌。
// 这是"差异化信号"（嫌疑花色 vs 非嫌疑花色）的直接证据；逐位等价性由 opponentRiskExposure.test.ts 保证。
import { describe, expect, it } from 'vitest'
import { decideBloodFlowActionEv, bloodFlowOpponentRisk } from './ai'
import { BLOOD_FLOW_AI, type BloodFlowAiConfig } from './config'
import type { BloodFlowSeatView } from './seatView'
import { isHonorTile, isTerminalTile, suitOfTile } from '../../../shared/ai/opponentPatternRisk'
import type { TileType } from '../../../core/contracts/types'

const peng = (tile: TileType) => ({ type: 'peng', tile, tiles: [tile, tile, tile] as TileType[], from: 1 })
/** 手牌：两组万子搭子 + 一条顺子 + 东风对 + 两个等价值孤张（p1 在嫌疑花色、m9 不在）。 */
const HAND: TileType[] = ['p1', 'm9', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 's2', 's3', 's4', 'east', 'east']
/** 手上第一个孤张就是嫌疑花色，便于断言"档位版不再先打它"。 */
const SUSPECT_INDEX = 0

function view(hand: TileType[], opponentMelds: ReturnType<typeof peng>[]): BloodFlowSeatView {
  const players = [0, 1, 2, 3].map(index => ({
    seat: index, score: 2000, hand: index === 0 ? [...hand] : [], discards: [],
    melds: index === 1 ? opponentMelds : [], concealedTileCount: 13,
  }))
  return {
    seat: 0, wallCount: 40, flipTile: 'east', jokers: ['white'], version: 1, players,
    public: { seats: [0, 1, 2, 3].map(() => ({ winCount: 0, locked: false })), batches: [] },
    ownActions: hand.map((_, index) => ({ kind: 'discard', index }) as const),
    window: {
      id: 'w', version: 1, kind: 'turn', deadlineAt: 0, opensAt: 0,
      source: { id: 's', kind: 'draw', tile: hand[hand.length - 1], seat: 0 },
    },
  } as unknown as BloodFlowSeatView
}

const off: BloodFlowAiConfig = { ...BLOOD_FLOW_AI, opponentPatternRisk: 'off' }
const flush = [peng('p4'), peng('p7')]

/** 十三幺 / 字一色教科书牌河：12 张全是中张，一个字牌与幺九都没打。 */
const ORPHANS_RIVER: TileType[] = ['m3', 'm4', 'm5', 'm6', 'm7', 'p3', 'p4', 'p5', 'p6', 'p7', 's3', 's4']
/** 同一个手牌、只换对手牌河，用于隔离"是不是读牌在看牌河"。 */
const CONCEALED_HAND: TileType[] = ['m1', 's5', 's7', 's8', 's9', 'm8', 'm9', 'p8', 'p9', 'p1', 'p2', 'east', 'east']

function riverView(hand: TileType[], river: TileType[]): BloodFlowSeatView {
  const players = [0, 1, 2, 3].map(index => ({
    seat: index, score: 2000, hand: index === 0 ? [...hand] : [],
    discards: index === 1 ? [...river] : [], melds: [], concealedTileCount: 13,
  }))
  return {
    seat: 0, wallCount: 30, flipTile: 'red', jokers: ['white'], version: 1, players,
    public: { seats: [0, 1, 2, 3].map(() => ({ winCount: 0, locked: false })), batches: [] },
    ownActions: hand.map((_, index) => ({ kind: 'discard', index }) as const),
    window: {
      id: 'w', version: 1, kind: 'turn', deadlineAt: 0, opensAt: 0,
      source: { id: 's', kind: 'draw', tile: hand[hand.length - 1], seat: 0 },
    },
  } as unknown as BloodFlowSeatView
}

describe('对手风险定价对引擎弃牌选择的影响', () => {
  it('对手副露染手时：off 照旧先打嫌疑花色孤张，tier 改打非嫌疑花色', () => {
    const legacy = decideBloodFlowActionEv(view(HAND, flush), off)!
    const risky = decideBloodFlowActionEv(view(HAND, flush), BLOOD_FLOW_AI)!
    expect(legacy).toEqual({ kind: 'discard', index: SUSPECT_INDEX })
    expect(risky.kind).toBe('discard')
    expect(risky).not.toEqual(legacy)
    expect(suitOfTile(HAND[(risky as { index: number }).index])).not.toBe('p')
  })

  it('没有任何风险信号时两臂完全等价（同一局面）', () => {
    expect(decideBloodFlowActionEv(view(HAND, []), BLOOD_FLOW_AI)).toEqual(decideBloodFlowActionEv(view(HAND, []), off))
  })

  it('对手只是普通副露（不构成风险档）时两臂仍然一致', () => {
    const plain = [peng('m2'), peng('s6')]
    expect(decideBloodFlowActionEv(view(HAND, plain), BLOOD_FLOW_AI)).toEqual(decideBloodFlowActionEv(view(HAND, plain), off))
  })

  it('门清十三幺嫌疑：off 照旧打幺九，档位版改打中张（损失最小化）', () => {
    const seatView = riverView(CONCEALED_HAND, ORPHANS_RIVER)
    const legacy = decideBloodFlowActionEv(seatView, off)!
    const risky = decideBloodFlowActionEv(seatView, BLOOD_FLOW_AI)!
    expect(bloodFlowOpponentRisk(seatView)[0]).toMatchObject({
      tier: 3, signals: expect.arrayContaining(['牌河零字牌幺九']),
    })
    expect(legacy).toEqual({ kind: 'discard', index: 0 })            // 旧口径：先打孤张幺九 m1
    expect(risky.kind).toBe('discard')
    expect(risky).not.toEqual(legacy)
    const chosen = CONCEALED_HAND[(risky as { index: number }).index]
    expect(isTerminalTile(chosen) || isHonorTile(chosen)).toBe(false) // 不再送出幺九/字牌
  })

  it('同一手牌换回均衡牌河时没有门清大牌信号，两臂回到一致', () => {
    const balanced: TileType[] = ['m3', 'm4', 'm5', 'p3', 'p4', 'p5', 's3', 's4', 's5', 'east', 'south', 'north']
    expect(bloodFlowOpponentRisk(riverView(CONCEALED_HAND, balanced))[0].tier).toBe(1)
    expect(decideBloodFlowActionEv(riverView(CONCEALED_HAND, balanced), BLOOD_FLOW_AI))
      .toEqual(decideBloodFlowActionEv(riverView(CONCEALED_HAND, balanced), off))
  })
})
