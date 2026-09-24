import { expect, it } from 'vitest'
import type { TileType } from '../core/contracts/types'
import { buildDecisionRequest, heuristicScore, inferiorClassicDiscard } from './candidates'
import { buildPrompt } from './prompt'

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

it('rejects only a clearly dominated classic discard, preserving ambiguous tradeoffs', () => {
  const hand: TileType[] = [
    'm6', 'm7', 'm8', 'p6', 'p6', 'p7', 'p8', 'p8', 'p9',
    's1', 's4', 's4', 'west', 'p1',
  ]
  const request = buildDecisionRequest({
    ruleCode: 'lotus-classic', decision: 'turn', playerIndex: 2,
    hand, melds: [], exposedMelds: 0, wallCount: 40, visibleTiles: hand,
  }).request!
  const first = request.candidates.find((candidate) => candidate.id === 'A1')!
  const recommended = request.candidates.find((candidate) => candidate.id === request.engineSuggestion)!
  expect(hand[first.action.kind === 'discard' ? first.action.handIndex : -1]).toBe('m6')
  expect(hand[recommended.action.kind === 'discard' ? recommended.action.handIndex : -1]).toBe('west')
  const prompt = buildPrompt('稳健', request).user
  expect(prompt).toContain(`【默认参考】选择「${request.engineSuggestion}」`)
  const outputInstruction = (user: string) => user.slice(user.indexOf('【输出】'))
  expect(outputInstruction(prompt)).not.toContain(request.engineSuggestion)
  // 对照同一局面、只换默认参考：输出格式不得再次塞入任何候选编号。
  const alternativePrompt = buildPrompt('稳健', { ...request, engineSuggestion: first.id }).user
  expect(alternativePrompt).toContain(`【默认参考】选择「${first.id}」`)
  expect(outputInstruction(alternativePrompt)).toBe(outputInstruction(prompt))
  for (const candidate of request.candidates) {
    expect(outputInstruction(prompt)).not.toContain(`"${candidate.id}"`)
  }
  expect(inferiorClassicDiscard(request, first)).toBe(true)
  expect(inferiorClassicDiscard(request, recommended)).toBe(false)
  // A higher ukeire can be an intentional tradeoff for temporarily higher shanten.
  const tradeoff = { ...first, features: { ...first.features,
    ukeire: (recommended.features.ukeire as number) + 1 } }
  expect(inferiorClassicDiscard(request, tradeoff)).toBe(false)
  const sameShanten = { ...first, features: { ...first.features,
    shanten: recommended.features.shanten, ukeire: 0 } }
  expect(inferiorClassicDiscard(request, sameShanten)).toBe(false)
  expect(inferiorClassicDiscard({ ...request, ruleCode: 'lotus-legacy' }, first)).toBe(false)

  // A second recorded shape: both ukeire values are zero at high shanten,
  // so the one-shanten regression alone is enough to reject the model's A1.
  const farHand: TileType[] = [
    'm3', 'm6', 'm9', 'p2', 'p5', 's3', 's6', 's7',
    'south', 'west', 'west', 'green', 'white', 'm1',
  ]
  const farRequest = buildDecisionRequest({
    ruleCode: 'lotus-classic', decision: 'turn', playerIndex: 3,
    hand: farHand, melds: [], exposedMelds: 0, wallCount: 80, visibleTiles: farHand,
  }).request!
  const farFirst = farRequest.candidates.find((candidate) => candidate.id === 'A1')!
  expect(inferiorClassicDiscard(farRequest, farFirst)).toBe(true)
})
