import { describe, expect, it } from 'vitest'
import type { TileType } from '../../core/contracts/types'
import { waitingTiles } from '../../core/rules/rules'
import { evaluateHandProgress, standardShanten } from './handProgress'

describe('handProgress 精确牌效', () => {
  it('标准牌型区分胡牌、听牌和一向听', () => {
    const winning: TileType[] = [
      'm1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p4', 'p5', 'p6',
      's7', 's8', 's9', 'east', 'east',
    ]
    expect(standardShanten(winning, 0, ['white'])).toBe(-1)
    expect(standardShanten(winning.slice(0, -1), 0, ['white'])).toBe(0)

    const oneAway: TileType[] = [
      'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3',
      'east', 'east', 'south', 'west',
    ]
    expect(standardShanten(oneAway, 0, ['white'])).toBe(1)
  })

  it('有效进张按全部可见牌扣减', () => {
    const hand: TileType[] = [
      'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3',
      'east', 'east', 'south', 'west',
    ]
    const base = evaluateHandProgress(hand, {
      exposedMelds: 0,
      wildcardTiles: ['white'],
      visibleTiles: hand,
      waitingTiles,
    })
    const depleted = evaluateHandProgress(hand, {
      exposedMelds: 0,
      wildcardTiles: ['white'],
      visibleTiles: [...hand, 'south', 'south', 'south', 'west', 'west', 'west'],
      waitingTiles,
    })
    expect(base.shanten).toBe(1)
    expect(base.ukeire).toBeGreaterThan(depleted.ukeire)
  })
})
