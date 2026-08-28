import { describe, expect, it } from 'vitest'
import { ConditionalReasoningCoordinator, DEFAULT_CONDITIONAL_REASONING, estimateOpponentThreat, evaluateReasoningTriggers } from './conditionalReasoning'
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
      { id: 'A1', label: '出1万', action: { kind: 'discard', handIndex: 0 }, features, legalityKey: 'a' },
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
  it('候选接近时触发，并遵守每小局与整场限额', () => {
    const coordinator = new ConditionalReasoningCoordinator(DEFAULT_CONDITIONAL_REASONING, () => 1)
    expect(coordinator.admit(request(), 5000).enabled).toBe(true)
    expect(coordinator.admit(request(), 5000).enabled).toBe(true)
    expect(coordinator.admit(request(), 5000).enabled).toBe(false)
    expect(coordinator.admit(request({ roundIndex: 1 }), 4999).enabled).toBe(false)
  })

  it('三副露且明显染手达到高威胁，但仅自摸玩法不以防铳触发', () => {
    const meld = { type: 'peng', tile: '2万', tiles: ['2万', '2万', '2万'] }
    const legacy = request({ snapshots: {
      self: { discards: [], melds: [] }, upper: { discards: ['东风'], melds: [meld, meld, meld] },
      opposite: { discards: [], melds: [] }, lower: { discards: [], melds: [] },
    } })
    expect(estimateOpponentThreat(legacy)).toBeGreaterThanOrEqual(70)
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
