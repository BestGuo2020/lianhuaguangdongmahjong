import { describe, expect, it } from 'vitest'
import type { TileType } from '../core/contracts/types'
import { chooseDiscardIndex, decideClaim, decideRobKong, decideTurn } from './lotusAi'
import type { LotusClaimView, LotusTurnView } from './lotusAi'
import type { ChiMeld } from './lotusRules'

const JOKERS: TileType[] = ['white', 'red']

function turnView(hand: TileType[], melds = [], exposedMelds = 0, kongBloom = false, jokers = JOKERS): LotusTurnView {
  return { hand, melds, exposedMelds, kongBloom, jokers }
}

describe('莲花麻将 AI 回合决策', () => {
  it('能胡自摸则胡', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east', 'east']
    expect(decideTurn(turnView(hand))).toEqual({ kind: 'win' })
  })
  it('补杠优先于暗杠与弃牌', () => {
    const hand: TileType[] = ['east', 'east', 'north']
    const melds = [{ type: 'peng', tile: 'east', tiles: ['east', 'east', 'east'] }]
    const decision = decideTurn(turnView(hand, melds))
    expect(decision.kind).toBe('added-kong')
  })
  it('暗杠（非精）优先于弃牌', () => {
    const hand: TileType[] = ['m1', 'm1', 'm1', 'm1', 'm2', 'm3']
    const decision = decideTurn(turnView(hand))
    expect(decision).toEqual({ kind: 'concealed-kong', tile: 'm1' })
  })
  it('乱风杠优先于弃牌', () => {
    const hand: TileType[] = ['east', 'south', 'west', 'north', 'm2', 'm3']
    const decision = decideTurn(turnView(hand))
    expect(decision).toEqual({ kind: 'wind-kong' })
  })
  it('精不能暗杠', () => {
    const hand: TileType[] = ['white', 'white', 'white', 'white', 'm2', 'm3']
    const decision = decideTurn(turnView(hand, [], 0, false, ['north', 'white']))
    expect(decision.kind).toBe('discard')
  })
})

describe('莲花麻将 AI 吃碰杠决策', () => {
  const claimView = (overrides: Partial<LotusClaimView> = {}): LotusClaimView => ({
    hand: [], tile: 'm4', from: 1, canGang: false, chiOptions: [], jokers: JOKERS, ...overrides,
  })
  it('能杠必杠', () => {
    expect(decideClaim(claimView({ canGang: true }))).toEqual({ kind: 'gang' })
  })
  it('能碰必碰并给出后续弃牌索引', () => {
    const decision = decideClaim(claimView({ hand: ['m4', 'm4', 's1', 's9'] }))
    expect(decision.kind).toBe('peng')
    if (decision.kind === 'peng') {
      expect(decision.discardIndex).toBeGreaterThanOrEqual(0)
    }
  })
  it('能吃则吃', () => {
    const chiOptions: ChiMeld[] = [{ kind: 'sequence', tiles: ['m2', 'm3', 'm4'] }]
    const decision = decideClaim(claimView({ chiOptions }))
    expect(decision).toEqual({ kind: 'chi', meld: chiOptions[0] })
  })
  it('否则过', () => {
    expect(decideClaim(claimView())).toEqual({ kind: 'pass' })
  })
})

describe('抢杠', () => {
  it('能抢必抢', () => {
    expect(decideRobKong({ hand: [], exposedMelds: 0, tile: 'east', from: 0, jokers: JOKERS })).toBe('win')
  })
})

describe('弃牌启发式', () => {
  it('优先保留精，打出孤张', () => {
    const hand: TileType[] = ['m1', 'm2', 'north', 'white']
    const index = chooseDiscardIndex(hand, ['north', 'white'], () => 0)
    expect(hand[index]).toBe('m1')
  })
  it('癞子面不因字牌加罚而被优先打出', () => {
    const hand: TileType[] = ['north', 'white', 'east']
    const index = chooseDiscardIndex(hand, ['north', 'white'], () => 0)
    expect(hand[index]).toBe('east')
  })
})
