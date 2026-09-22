// 兜/弃政策在引擎里的实际效果（v3）：
//   ① 未听牌 + 对手已公开十六倍级大牌 + 可达听口过窄 → 走兜牌：只打最小赔付张。
//   ② 对照：同一局面若只有牌河推断（没有公开番型），锁手家一律同价 → 兜牌挑不出差别，
//      这正是"公开番型"带来的分辨力。
//   ③ 我方上限不低于对手 → 不走兜牌（赌）。
import { describe, expect, it } from 'vitest'
import { bloodFlowAiActions, bloodFlowDefensePolicy, bloodFlowSafetyExposure, decideBloodFlowActionEv } from './ai'
import { buildBloodFlowDecisionInput } from '../../../llm/bloodFlowDecisionInput'
import { BLOOD_FLOW_AI } from './config'
import type { BloodFlowSeatView } from './seatView'
import type { TileType } from '../../../core/contracts/types'

const ORPHANS_RIVER: TileType[] = ['m2', 'm3', 'm5', 'm6', 'm7', 'p3', 'p4', 'p5', 'p6', 'p7', 's2', 's3']
/** 未听牌、听口极窄，手上同时有孤张幺九/字牌（危险）与中张（对十三幺安全）。 */
const HAND: TileType[] = ['m1', 'm1', 'm4', 'm4', 'm7', 'm7', 'p2', 'p2', 'p5', 'p8', 's3', 's9', 'east', 'red']
/** 本家自己就是十三幺/字一色形态（上限 16 倍）→ 按规则③可以赌。 */
const RACING_HAND: TileType[] = ['m1', 'm9', 'p1', 'p9', 's1', 's9', 'east', 'south', 'west', 'north', 'red', 'green', 'white', 'm5']

function thirteenOrphansBatch(): never[] {
  const score = {
    items: [{ id: 'thirteenOrphans', label: '十三幺', weight: 16 }], excluded: [], hardWin: true,
    source: 'self-draw', opening: null, patternMultiplier: 16, eventMultiplier: 2, openingApplied: false,
    uncappedMultiplier: 32, finalMultiplier: 64, capped: false, paymentPerPayer: 640,
  }
  return [{
    authorityEpoch: 'e', roundId: '1', sequence: 1, ruleVersion: 'lotus-blood-flow-v1', batchId: 'b1', windowId: 'w1',
    source: { id: 's1', kind: 'draw', tile: 'north', seat: 1 },
    winners: [{ id: 'r1', batchId: 'b1', winner: 1, ordinal: 1, sourceEventId: 's1', score, deltas: [0, 0, 0, 0] }],
    nextAction: { kind: 'draw', seat: 2 },
  }] as never[]
}

function view(hand: TileType[], options: { knownWin?: boolean; claim?: boolean } = {}): BloodFlowSeatView {
  const players = [0, 1, 2, 3].map(index => ({
    seat: index, score: 2000, hand: index === 0 ? [...hand] : [],
    discards: index === 1 ? [...ORPHANS_RIVER] : [], melds: [], concealedTileCount: 13,
  }))
  const claim = options.claim === true
  return {
    seat: 0, wallCount: 30, flipTile: 'red', jokers: ['white'], version: 1, players,
    public: {
      seats: [0, 1, 2, 3].map(index => ({ winCount: index === 1 ? 2 : 0, locked: index === 1 })),
      batches: options.knownWin === false ? [] : thirteenOrphansBatch(),
    },
    ownActions: claim
      ? [{ kind: 'pass' }, { kind: 'peng' }]
      : hand.map((_, index) => ({ kind: 'discard', index }) as const),
    actionEvents: [],
    window: {
      id: 'w', version: 1, kind: claim ? 'meld' : 'turn', deadlineAt: 0, opensAt: 0,
      source: { id: 's', kind: claim ? 'discard' : 'draw', tile: hand[hand.length - 1], seat: 1 },
    },
  } as unknown as BloodFlowSeatView
}

const chosenIndex = (action: ReturnType<typeof decideBloodFlowActionEv>): number => {
  if (!action || action.kind !== 'discard') throw new Error(`expected discard, got ${action?.kind}`)
  return action.index
}

describe('兜牌在引擎里的效果', () => {
  it('规则②落地：未听牌 + 已知十六倍级锁手家 → 兜牌，打全场最小赔付张（中张）', () => {
    const seatView = view(HAND)
    const policy = bloodFlowDefensePolicy(seatView)
    expect(policy.result.mode).toBe('fold')
    expect(policy.own.anyWaitReachable).toBe(false)
    expect(policy.own.canTenpai).toBe(false)

    const exposure = bloodFlowSafetyExposure(seatView)
    const index = chosenIndex(decideBloodFlowActionEv(seatView, BLOOD_FLOW_AI))
    const cost = exposure(HAND[index])
    const minCost = Math.min(...HAND.map(tile => exposure(tile)))
    expect(cost).toBe(minCost)
    expect(cost).toBeLessThan(320)                    // 有分辨力：至少不是字牌/幺九的 320 点
    expect(['m4', 'm7', 'p2', 'p5', 'p8', 's3']).toContain(HAND[index])  // 打的是中张
  })

  it('对照：只有牌河推断（无公开番型）时锁手家一律同价，兜牌挑不出差别', () => {
    const seatView = view(HAND, { knownWin: false })
    const exposure = bloodFlowSafetyExposure(seatView)
    const costs = HAND.map(tile => exposure(tile))
    expect(new Set(costs).size).toBe(1)               // 全候选同价 —— 正是"公开番型"补上的分辨力
    expect(costs[0]).toBe(320)
  })

  it('规则③落地：我方上限 16 倍（十三幺形态）→ 不兜，继续赌', () => {
    const seatView = view(RACING_HAND)
    expect(bloodFlowDefensePolicy(seatView).result.mode).toBe('push')
    const action = decideBloodFlowActionEv(seatView, BLOOD_FLOW_AI)
    // 攻击与安全可同时成立：正确的十三幺路线应打闲张，而不是要求主动打危险幺九。
    expect(action).toEqual(decideBloodFlowActionEv(seatView, {
      ...BLOOD_FLOW_AI, defense: { ...BLOOD_FLOW_AI.defense, mode: 'off' },
    }))
    expect(RACING_HAND[chosenIndex(action)]).toBe('m5')
  })

  it('兜牌的保证：打到全场最小赔付张（与"只按 EV"的实测对比一并记录）', () => {
    const seatView = view(HAND)
    const exposure = bloodFlowSafetyExposure(seatView)
    const noFold = { ...BLOOD_FLOW_AI, defense: { ...BLOOD_FLOW_AI.defense, foldThreatTier: 99 as const } }
    const evIndex = chosenIndex(decideBloodFlowActionEv(seatView, noFold))
    const foldIndex = chosenIndex(decideBloodFlowActionEv(seatView, BLOOD_FLOW_AI))
    const evCost = exposure(HAND[evIndex])
    const foldCost = exposure(HAND[foldIndex])
    const minCost = Math.min(...HAND.map(tile => exposure(tile)))
    console.log(`FOLD 实测：只按EV=${HAND[evIndex]}(${evCost}点) 兜牌=${HAND[foldIndex]}(${foldCost}点) 全场最小=${minCost}点`)
    // 兜牌的确定性保证：
    expect(foldCost).toBe(minCost)
    // 实测说明：v1/v2 的赔付定价已在 netScore 里，所以"只按 EV"通常也选到同价张（本样本差值 0）。
    // 兜牌政策的独立价值因此主要在：① 这个"最小赔付"是保证而不是碰巧；② stop-claims；③ 给 LLM 的显式政策信号。
    expect(foldCost).toBeLessThanOrEqual(evCost)
  })

  it('兜牌硬约束：候选层撤掉吃碰杠、弃牌只留最小赔付档（引擎与 LLM 共用）', () => {
    const turn = view(HAND)
    const actions = bloodFlowAiActions(turn, BLOOD_FLOW_AI)
    expect(actions.every(action => action.kind === 'discard' || action.kind === 'win' || action.kind === 'pass')).toBe(true)
    const exposure = bloodFlowSafetyExposure(turn)
    const costs = actions.filter(action => action.kind === 'discard').map(action => exposure(HAND[(action as { index: number }).index]))
    expect(costs.length).toBeGreaterThan(0)
    expect(new Set(costs)).toEqual(new Set([Math.min(...costs)]))       // 全部落在安全档
    expect(actions.filter(action => action.kind === 'discard').length)
      .toBeLessThan(HAND.filter((tile, index) => HAND.indexOf(tile) === index).length)  // 确实收窄了

    const claim = view(HAND, { claim: true })
    expect(bloodFlowAiActions(claim, BLOOD_FLOW_AI).some(action => action.kind === 'peng')).toBe(false)

    // 关掉硬约束（= 只做引擎侧最小赔付）时候选不再收窄，用于对照
    const loose = { ...BLOOD_FLOW_AI, defense: { ...BLOOD_FLOW_AI.defense, mode: 'off' as const } }
    expect(bloodFlowAiActions(claim, loose).some(action => action.kind === 'peng')).toBe(true)
  })

  it('兜牌硬约束的出口：能打一张即任意听时不做任何收窄', () => {
    const racing = view(RACING_HAND)
    expect(bloodFlowDefensePolicy(racing).result.mode).toBe('push')
    const loose = { ...BLOOD_FLOW_AI, defense: { ...BLOOD_FLOW_AI.defense, mode: 'off' as const } }
    expect(bloodFlowAiActions(racing, BLOOD_FLOW_AI)).toEqual(bloodFlowAiActions(racing, loose))
  })

  it('LLM 候选与引擎同源：兜牌模式下候选里没有碰/吃/杠', () => {
    const built = buildBloodFlowDecisionInput(view(HAND, { claim: true }), 'fold-req')
    expect(built.candidates.some(candidate => candidate.action.kind === 'peng')).toBe(false)
    expect(built.candidates.map(candidate => candidate.action.kind)).toContain('pass')
  })

  it('兜牌模式下停吃碰杠：拿到碰的窗口也返回过', () => {
    expect(bloodFlowDefensePolicy(view(HAND, { claim: true })).result.mode).toBe('fold')
    expect(decideBloodFlowActionEv(view(HAND, { claim: true }), BLOOD_FLOW_AI)).toEqual({ kind: 'pass' })
  })
})
