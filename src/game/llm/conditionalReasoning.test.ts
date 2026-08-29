import { describe, expect, it } from 'vitest'
import {
  ConditionalReasoningCoordinator,
  DEFAULT_CONDITIONAL_REASONING,
  estimateOpponentThreat,
  evaluateReasoningTriggers,
} from './conditionalReasoning'
import type { DecisionRequest } from './schema'

function request(overrides: Partial<DecisionRequest['state']> = {}): DecisionRequest {
  const features = {
    shanten: 1 as const, ukeire: 4 as const, effectiveTiles: [], ready: false as const,
    waits: 'n/a' as const, effectiveRemaining: 'n/a' as const, specialPattern: 'none',
    safety: '中' as const, efficiency: '中' as const, risks: [],
  }
  return {
    schemaVersion: 1, requestId: 'r', stateVersion: 's', ruleCode: 'lotus-legacy', decision: 'turn',
    candidates: [
      { id: 'A1', label: '出1万', action: { kind: 'discard', handIndex: 0 }, features: { ...features, efficiency: '优' }, legalityKey: 'a' },
      { id: 'A2', label: '出2万', action: { kind: 'discard', handIndex: 1 }, features, legalityKey: 'b' },
    ],
    state: {
      schemaVersion: 1, requestId: 'r', stateVersion: 's', ruleCode: 'lotus-legacy', decision: 'turn',
      hand: [], turnOrigin: 'draw', drawnTile: null, claimTile: null, claimFrom: null, melds: [],
      snapshots: {
        self: { discards: [], melds: [] }, upper: { discards: [], melds: [] },
        opposite: { discards: [], melds: [] }, lower: { discards: [], melds: [] },
      },
      upperLastDiscard: null, jokerTiles: [], wildcardTiles: [], wallCount: 40,
      earlyRound: false, lateGame: false, scores: [1000, 2000, 3000, 4000], seatWind: '南',
      roundWind: '东', dealerIndex: 0, isDealer: false, roundIndex: 0, dihu: false,
      ...overrides,
    },
  }
}

describe('条件深度思考', () => {
  it('所有支持条件深思的供应商共用 40 秒请求与 45 秒总预算', () => {
    expect(DEFAULT_CONDITIONAL_REASONING.deadlineMs).toBe(40_000)
    expect(DEFAULT_CONDITIONAL_REASONING.minRemainingBudgetMs).toBe(45_000)
    expect(DEFAULT_CONDITIONAL_REASONING.maxPerSeatPerRound).toBe(2)
    expect(DEFAULT_CONDITIONAL_REASONING.maxSoftPerSeatPerRound).toBe(1)
    expect(DEFAULT_CONDITIONAL_REASONING.maxPerMatch).toBe(24)
    expect(DEFAULT_CONDITIONAL_REASONING.trigger.earlyOpponentThreat).toBe(90)
  })

  it('普通候选接近每座每局只使用一次软额度，并为强触发保留第二次机会', () => {
    const coordinator = new ConditionalReasoningCoordinator(DEFAULT_CONDITIONAL_REASONING, () => 1)
    expect(coordinator.admit(request(), 1, 45_000).enabled).toBe(true)
    expect(coordinator.admit(request(), 1, 45_000).enabled).toBe(false)
    expect(coordinator.admit(request(), 2, 45_000).enabled).toBe(true)
    const strong = request()
    strong.candidates[0].features.scoreDelta = 800
    expect(coordinator.admit(strong, 1, 45_000).enabled).toBe(true)
    expect(coordinator.admit(strong, 1, 45_000).enabled).toBe(false)
    expect(coordinator.admit(request({ roundIndex: 1 }), 1, 44_999).enabled).toBe(false)
  })

  it('庄家首打和前两巡都不因候选接近或审计抽样深思，但强触发器仍有效', () => {
    const opening = request({ turnOrigin: 'opening', earlyRound: true })
    const ordinary = evaluateReasoningTriggers(opening, DEFAULT_CONDITIONAL_REASONING, () => 0)
    expect(ordinary.enabled).toBe(false)
    expect(ordinary.reasons).not.toContain('close-candidates')
    expect(ordinary.reasons).not.toContain('audit')

    opening.candidates[0].features.scoreDelta = 800
    const strong = evaluateReasoningTriggers(opening, DEFAULT_CONDITIONAL_REASONING, () => 0)
    expect(strong.reasons).toContain('score-swing')

    const earlyDraw = request({ turnOrigin: 'draw', earlyRound: true })
    const early = evaluateReasoningTriggers(earlyDraw, DEFAULT_CONDITIONAL_REASONING, () => 0)
    expect(early.enabled).toBe(false)
    expect(early.reasons).not.toContain('close-candidates')
    expect(early.reasons).not.toContain('audit')
  })

  it('完全同质的零分差候选不升级思考', () => {
    const tied = request()
    tied.candidates[0].features = { ...tied.candidates[1].features }
    const result = evaluateReasoningTriggers(tied, DEFAULT_CONDITIONAL_REASONING, () => 1)
    expect(result.candidateScoreGap).toBe(0)
    expect(result.reasons).not.toContain('close-candidates')
    expect(result.enabled).toBe(false)
  })

  it('前两巡仅在多个不同听牌方案或碰杠可能破坏听牌时深思', () => {
    const ready = request({ earlyRound: true })
    ready.candidates[0].features = {
      ...ready.candidates[0].features,
      ready: true,
      waits: [{ tile: '3万', remaining: 2 }],
      effectiveRemaining: 2,
    }
    expect(evaluateReasoningTriggers(ready, DEFAULT_CONDITIONAL_REASONING, () => 1).enabled).toBe(false)

    ready.candidates[1].features = {
      ...ready.candidates[1].features,
      ready: true,
      waits: [{ tile: '6筒', remaining: 3 }],
      effectiveRemaining: 3,
    }
    expect(evaluateReasoningTriggers(ready, DEFAULT_CONDITIONAL_REASONING, () => 1).reasons)
      .toContain('ready-choice')

    const breakReady = request({ earlyRound: true })
    breakReady.candidates[0].features.risks = ['碰/杠可能破坏听牌']
    expect(evaluateReasoningTriggers(breakReady, DEFAULT_CONDITIONAL_REASONING, () => 1).reasons)
      .toContain('ready-choice')
  })

  it('全桌整场最多使用24次', () => {
    const coordinator = new ConditionalReasoningCoordinator(DEFAULT_CONDITIONAL_REASONING, () => 1)
    for (let round = 0; round < 4; round += 1) {
      for (const seat of [1, 2, 3]) {
        const strong = request({ roundIndex: round })
        strong.candidates[0].features.scoreDelta = 800
        expect(coordinator.admit(strong, seat, 45_000).enabled).toBe(true)
        expect(coordinator.admit(strong, seat, 45_000).enabled).toBe(true)
      }
    }
    expect(coordinator.admit(request({ roundIndex: 4 }), 1, 45_000).enabled).toBe(false)
  })

  it('前两巡两副露的中等威胁不触发，三副露明显染手才越过早巡门槛', () => {
    const meld = { type: 'peng', tile: '2万', tiles: ['2万', '2万', '2万'] }
    const snapshots = {
      self: { discards: [], melds: [] }, upper: { discards: ['东风'], melds: [meld, meld] },
      opposite: { discards: [], melds: [] }, lower: { discards: [], melds: [] },
    }
    const legacy = request({ earlyRound: true, snapshots })
    expect(estimateOpponentThreat(legacy)).toBe(70)
    expect(evaluateReasoningTriggers(legacy, DEFAULT_CONDITIONAL_REASONING, () => 1).reasons)
      .not.toContain('opponent-threat')

    legacy.state.snapshots.upper.melds.push(meld)
    expect(estimateOpponentThreat(legacy)).toBe(90)
    expect(evaluateReasoningTriggers(legacy, DEFAULT_CONDITIONAL_REASONING, () => 1).reasons).toContain('opponent-threat')
    legacy.ruleCode = 'lotus-classic'
    legacy.state.ruleCode = 'lotus-classic'
    expect(estimateOpponentThreat(legacy)).toBe(0)
  })

  it('scoreSwing 使用规则引擎精确收益而不是高低档位猜测', () => {
    const value = request()
    value.candidates[0].features.scoreDelta = 800
    value.candidates[0].features.scoreDeltaBand = '高'
    expect(evaluateReasoningTriggers(value, DEFAULT_CONDITIONAL_REASONING, () => 1).reasons)
      .toContain('score-swing')
  })
})
