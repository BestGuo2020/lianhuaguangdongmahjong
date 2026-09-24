import { expect, it } from 'vitest'
import type { TileType } from '../core/contracts/types'
import { buildDecisionRequest, type DecisionInput } from './candidates'

function recommendation(input: DecisionInput) {
  const built = buildDecisionRequest(input)
  const chosen = built.request?.candidates.find((candidate) => candidate.id === built.request?.engineSuggestion)
  expect(chosen?.action.kind).toBe('discard')
  expect(built.fallbackAction).toEqual(chosen?.action)
  return chosen!
}

it('翻精早巡：推荐不继续选 3 向听 0 进张的低安全牌（对局 round-3/window/8）', () => {
  const hand: TileType[] = [
    'm1', 'm1', 'p3', 'p7', 'p9', 'p9', 's1', 's2', 's2', 's4', 'north', 'red', 'white', 'east',
  ]
  const publicTiles: TileType[] = ['p1', 's8', 'm4', 's8', 'north', 'm4']
  const chosen = recommendation({
    ruleCode: 'lotus-legacy', decision: 'turn', playerIndex: 2,
    hand, melds: [], exposedMelds: 0,
    jokerTiles: ['m2', 'm3'], wildcardTiles: ['white'],
    visibleTiles: [...hand, ...publicTiles], publicTiles, upperLastDiscard: 'm4',
    wallCount: 75, earlyRound: true,
  })
  expect(chosen.features.shanten).toBeLessThanOrEqual(2)
  expect(chosen.features.ukeire).toBeGreaterThan(0)
})

it('翻精吃后早巡：安全度相同时推荐使用已算出的向听，回退仍是合法弃牌', () => {
  const hand: TileType[] = ['m7', 'm9', 'p7', 'p8', 's4', 's5', 'west', 'north', 'red', 'red', 'white']
  // 手牌与精牌取自 round-2/window/15；清空公共牌让各候选安全度相同。
  const publicTiles: TileType[] = []
  const chosen = recommendation({
    ruleCode: 'lotus-legacy', decision: 'turn', playerIndex: 3, skipDraw: true,
    hand, melds: [{ type: 'chi', tile: 's8', tiles: ['s7', 's8', 's9'], from: 1 }], exposedMelds: 1,
    jokerTiles: ['m5', 'm6'], wildcardTiles: ['white'],
    visibleTiles: hand, publicTiles,
    wallCount: 72, earlyRound: true,
  })
  expect(chosen.features.shanten).toBeLessThanOrEqual(1)
})

it('翻精早巡：更低向听但明显更危险时保留安全推荐（对局 round-4/window/16）', () => {
  const hand: TileType[] = [
    'east', 'm5', 'm9', 's2', 's4', 's5', 's7', 's7', 's8', 's9', 'west', 'green', 'white', 's6',
  ]
  const publicTiles: TileType[] = ['p7', 's1', 'p7', 's4', 'p1', 'p7', 's5', 'p2', 's9', 'p3']
  const chosen = recommendation({
    ruleCode: 'lotus-legacy', decision: 'turn', playerIndex: 3,
    hand, melds: [], exposedMelds: 0,
    jokerTiles: ['east', 'south'], wildcardTiles: ['white'],
    visibleTiles: [...hand, ...publicTiles], publicTiles, upperLastDiscard: 's4',
    wallCount: 71, earlyRound: true,
  })
  expect(chosen.features.safety).toBe('高')
})
