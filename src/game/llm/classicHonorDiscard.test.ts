import { expect, it } from 'vitest'
import type { TileType } from '../core/contracts/types'
import { buildDecisionRequest, heuristicScore } from './candidates'

it('classic model prompt ranks an ordinary singleton honor as a useful discard and suggests it', () => {
  const hand: TileType[] = [
    'm2', 'm2', 'm5', 'm5', 'm7', 'p2', 'p3', 'p4', 'p7', 's8',
    'west', 'green', 'white', 'white',
  ]
  const built = buildDecisionRequest({
    ruleCode: 'lotus-classic', decision: 'turn', playerIndex: 3,
    hand, melds: [], exposedMelds: 0, wallCount: 79, visibleTiles: hand,
  })
  const candidates = built.request!.candidates
  const west = candidates.find((candidate) => candidate.label === '出西风')!
  const pair = candidates.find((candidate) => candidate.label === '出2万')!
  const suggested = candidates.find((candidate) => candidate.id === built.request!.engineSuggestion)!
  expect(west.features.shanten).toBeLessThan(pair.features.shanten as number)
  expect(west.features.efficiency).toBe('优')
  expect(pair.features.efficiency).not.toBe('优')
  expect(['出西风', '出发财']).toContain(suggested.label)
  expect(['west', 'green']).toContain(hand[(built.fallbackAction as { handIndex: number }).handIndex])
  expect(heuristicScore(hand, 'west', new Set(['white']), true)).toBeLessThan(
    heuristicScore(hand, 'm2', new Set(['white']), true),
  )
  expect(heuristicScore(['east', 'east', 'm7'], 'east', new Set(), true)).toBeGreaterThan(
    heuristicScore(['east', 'east', 'm7'], 'm7', new Set(), true),
  )
})

it('classic suggestion follows a ready discard rather than the cheap shape shortlist', () => {
  const hand: TileType[] = ['p3', 'p3', 'p8', 'p9', 's3', 's4', 's5', 's6', 's7', 's8', 's5']
  const built = buildDecisionRequest({
    ruleCode: 'lotus-classic', decision: 'turn', playerIndex: 1,
    hand, melds: [{ type: 'peng', tile: 'm9', tiles: ['m9', 'm9', 'm9'], from: 2 }],
    exposedMelds: 1, wallCount: 38, visibleTiles: hand,
  })
  const candidates = built.request!.candidates
  const suggested = candidates.find((candidate) => candidate.id === built.request!.engineSuggestion)!
  expect(suggested.features.shanten).toBe(0)
  expect(suggested.features.efficiency).toBe('优')
  expect(['出5条', '出8条']).toContain(suggested.label)
})
