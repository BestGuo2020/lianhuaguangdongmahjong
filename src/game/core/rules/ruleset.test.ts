import { describe, expect, it, vi } from 'vitest'
import { CLASSIC_RULESET, scoreHand } from './rules'
import { DEFAULT_RULESET, withRuleSetOverrides, type RuleSet } from './ruleset'

const hand = [
  'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4',
  's7', 's7', 's7', 'east', 'east',
] as const

describe('ruleset injection', () => {
  it('keeps the default ruleset identical to the legacy core exports', () => {
    expect(DEFAULT_RULESET).toBe(CLASSIC_RULESET)
    expect(DEFAULT_RULESET.win.isWinningHand([...hand])).toBe(true)
    expect(DEFAULT_RULESET.score.scoreHand({ dealer: true, noJoker: true, fourRed: true, horseHits: 2 }))
      .toEqual(scoreHand({ dealer: true, noJoker: true, fourRed: true, horseHits: 2 }))
  })

  it('allows a ruleset to replace hand evaluation without changing callers', () => {
    const isWinningHand = vi.fn(() => false)
    const custom = withRuleSetOverrides(DEFAULT_RULESET, {
      id: 'test-patterns',
      win: { isWinningHand },
      flow: { mode: 'blood-battle', continueAfterWin: true, allowMultipleWinners: true },
    })

    expect(custom.id).toBe('test-patterns')
    expect(custom.win.isWinningHand([...hand])).toBe(false)
    expect(isWinningHand).toHaveBeenCalledWith([...hand])
    expect(custom.flow).toEqual({ mode: 'blood-battle', continueAfterWin: true, allowMultipleWinners: true })
  })

  it('keeps blood-flow metadata as an explicit future extension point', () => {
    const bloodFlow = withRuleSetOverrides(DEFAULT_RULESET, {
      id: 'blood-flow-preview',
      flow: { mode: 'blood-flow', continueAfterWin: true, allowMultipleWinners: true },
      extension: { patternProviders: ['qingyise'], settlementHooks: ['continue-round'] },
    })

    expect(bloodFlow.flow.mode).toBe('blood-flow')
    expect(bloodFlow.extension).toEqual({
      patternProviders: ['qingyise'],
      settlementHooks: ['continue-round'],
    })
  })
})

describe('ruleset default surface', () => {
  it('exposes stable score and win capabilities for engine wiring', () => {
    const ruleset: RuleSet = DEFAULT_RULESET
    expect(ruleset.baseScore).toBe(100)
    expect(ruleset.win.waitingTiles(hand.slice(0, -1))).toContain('east')
    expect(ruleset.score.scoreHand({ horseHits: 1 }).points).toBe(200)
  })
})
