// 档位版是否真的改变引擎选择：同一局面下 off 与 tier 必须选出不同的弃牌。
// 这是"差异化信号"（嫌疑花色 vs 非嫌疑花色）的直接证据；逐位等价性由 opponentRiskExposure.test.ts 保证。
import { describe, expect, it } from 'vitest'
import { decideBloodFlowActionEv } from './ai'
import { BLOOD_FLOW_AI, type BloodFlowAiConfig } from './config'
import type { BloodFlowSeatView } from './seatView'
import { suitOfTile } from '../../../shared/ai/opponentPatternRisk'
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
})
