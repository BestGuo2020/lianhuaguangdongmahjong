// 门清大牌「损失最小化」的反事实度量：档位版选的牌 vs 旧口径选的牌，估算赔付差与进攻代价。
// 这是本次 v2 的效果证据来源——端局聚合指标对这类定价不敏感（见 docs 的效果边界小节），
// 所以把"避免了多少钱、付出多少进张"直接算在决策点上，并作为默认回归的一部分。
import { describe, expect, it } from 'vitest'
import { bloodFlowOpponentRisk, bloodFlowSafetyExposure, decideBloodFlowActionEv } from './ai'
import { BLOOD_FLOW_AI, type BloodFlowAiConfig } from './config'
import type { BloodFlowSeatView } from './seatView'
import { waitingTiles } from '../lotusRules'
import { evaluateHandProgress } from '../../../shared/ai/handProgress'
import { isHonorTile, isTerminalTile } from '../../../shared/ai/opponentPatternRisk'
import type { TileType } from '../../../core/contracts/types'

/**
 * 十三幺 / 字一色教科书牌河：12 张全是中张，一个字牌与幺九都没打。
 * 刻意避开本家手上的牌（否则"打现物"会盖过读牌效果），也避开 m4/s4（否则触发既有 1·4·7 软提示）。
 */
const ORPHANS_RIVER: TileType[] = ['m2', 'm3', 'm5', 'm6', 'm7', 'p3', 'p4', 'p5', 'p6', 'p7', 's2', 's3']
/** 手牌：孤张幺九 m1 + 孤张中张 s5 + 两组搭子 + 东风对。 */
const HAND: TileType[] = ['m1', 's5', 's7', 's8', 's9', 'm8', 'm9', 'p8', 'p9', 'p1', 'p2', 'east', 'east']

const off: BloodFlowAiConfig = { ...BLOOD_FLOW_AI, opponentPatternRisk: 'off' }

function view(): BloodFlowSeatView {
  const players = [0, 1, 2, 3].map(index => ({
    seat: index, score: 2000, hand: index === 0 ? [...HAND] : [],
    discards: index === 1 ? [...ORPHANS_RIVER] : [], melds: [], concealedTileCount: 13,
  }))
  return {
    seat: 0, wallCount: 30, flipTile: 'red', jokers: ['white'], version: 1, players,
    public: { seats: [0, 1, 2, 3].map(() => ({ winCount: 0, locked: false })), batches: [] },
    ownActions: HAND.map((_, index) => ({ kind: 'discard', index }) as const),
    window: {
      id: 'w', version: 1, kind: 'turn', deadlineAt: 0, opensAt: 0,
      source: { id: 's', kind: 'draw', tile: HAND[HAND.length - 1], seat: 0 },
    },
  } as unknown as BloodFlowSeatView
}

const progressOf = (hand: TileType[]) => evaluateHandProgress(hand, {
  exposedMelds: 0, wildcardTiles: ['white'], visibleTiles: hand,
  waitingTiles: (tiles, exposed) => waitingTiles(tiles, exposed, []), specialHands: true,
})

const chosenIndex = (action: ReturnType<typeof decideBloodFlowActionEv>): number => {
  if (!action || action.kind !== 'discard') throw new Error('expected a discard')
  return action.index
}

describe('门清大牌损失最小化（反事实度量）', () => {
  const seatView = view()
  const exposure = bloodFlowSafetyExposure(seatView)
  const legacyIndex = chosenIndex(decideBloodFlowActionEv(view(), off))
  const riskIndex = chosenIndex(decideBloodFlowActionEv(view(), BLOOD_FLOW_AI))

  it('读牌成立：门清十三幺嫌疑 tier3，且每张牌按该牌型真正需要的牌分价', () => {
    expect(bloodFlowOpponentRisk(seatView)[0]).toMatchObject({
      tier: 3, signals: expect.arrayContaining(['牌河零字牌幺九']),
    })
    expect(exposure('north')).toBe(320)   // 活字牌
    expect(exposure('m9')).toBe(128)      // 幺九（手里 1 张，多现不归零）
    expect(exposure('s5')).toBe(32)       // 中张：十三幺几乎不需要
  })

  it('旧口径先送幺九，档位版改送中张：赔付从 128 降到 32（避免 96 点）', () => {
    expect(isTerminalTile(HAND[legacyIndex]) || isHonorTile(HAND[legacyIndex])).toBe(true)
    expect(isTerminalTile(HAND[riskIndex]) || isHonorTile(HAND[riskIndex])).toBe(false)
    const legacyCost = exposure(HAND[legacyIndex])
    const riskCost = exposure(HAND[riskIndex])
    console.log(`LOSS-MIN legacy=${HAND[legacyIndex]}(${legacyCost}) → risk=${HAND[riskIndex]}(${riskCost})，避免赔付 ${legacyCost - riskCost} 点`)
    expect(legacyCost - riskCost).toBeGreaterThan(0)
  })

  it('代价可查：改打的牌不比旧选择更伤牌效（本例进张与向听都不亏）', () => {
    const after = (index: number) => progressOf(HAND.filter((_, i) => i !== index))
    const legacyProgress = after(legacyIndex)
    const riskProgress = after(riskIndex)
    console.log(`LOSS-MIN 进张：legacy=${legacyProgress.ukeire}(向听${legacyProgress.shanten}) risk=${riskProgress.ukeire}(向听${riskProgress.shanten})`)
    expect(riskProgress.shanten).toBeLessThanOrEqual(legacyProgress.shanten)
    expect(riskProgress.ukeire).toBeGreaterThanOrEqual(legacyProgress.ukeire)
  })
})
