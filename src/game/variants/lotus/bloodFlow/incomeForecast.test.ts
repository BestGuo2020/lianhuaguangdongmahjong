import { describe, expect, it } from 'vitest'
import type { TileType } from '../../../core/contracts/types'
import { forecastSelfDrawIncome, forecastWinIncome, ownDrawOpportunities } from './incomeForecast'

describe('canonical income and physical draw opportunities', () => {
  const hand = 'east east south p3 p4 p5 p6 p6 p7 p9 white white white'.split(' ') as TileType[]
  const jokers: TileType[] = ['east', 'south']
  it('counts seat position, short walls and horizon without inventing a draw', () => {
    expect([0, 1, 3, 4, 7, 8, 13, 69].map(w => ownDrawOpportunities(w, 8))).toEqual([0, 0, 0, 1, 1, 2, 3, 8])
    expect(ownDrawOpportunities(3, 8, 1)).toBe(1)
    expect(ownDrawOpportunities(40, 0)).toBe(0)
  })
  it('uses the canonical score for the reproduced late-game overestimate', () => {
    expect(forecastWinIncome(hand, [], jokers, 'white', 'self-draw')).toBe(360)
    expect(forecastWinIncome(hand, [], jokers, 'white', 'discard')).toBe(50)
  })
  it('does not turn remaining unseen copies into guaranteed future income', () => {
    expect(forecastSelfDrawIncome(hand, [], jokers, hand, 3, 8)).toBe(0)
    const once = forecastSelfDrawIncome(hand, [], jokers, hand, 4, 8)
    expect(once).toBeGreaterThan(0)
    expect(forecastSelfDrawIncome(hand, [], jokers, hand, 8, 8)).toBeCloseTo(once * 2)
    expect(forecastSelfDrawIncome(hand, [], jokers, hand, 40, 1)).toBeCloseTo(once)
  })
})
