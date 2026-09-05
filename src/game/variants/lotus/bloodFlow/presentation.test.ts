import { expect, it } from 'vitest'
import { BloodFlowPresentationQueue, winTier } from './presentation'
import { scorePatterns } from '../patterns/score'
import type { PatternId } from '../patterns/types'
import type { Seat, WinBatch } from './types'
import { vector } from './state'

function batch(id: number, patterns: PatternId[] = ['all-green'], seat: Seat = 0): WinBatch {
  const score = scorePatterns(patterns, true, 'self-draw')
  const deltas = vector(s => s === seat ? score.paymentPerPayer * 3 : -score.paymentPerPayer)
  return { authorityEpoch: 'test', sequence: id, roundId: '1', ruleVersion: 'lotus-blood-flow-v1', batchId: `b${id}`, windowId: `w${id}`,
    source: { id: `s${id}`, seat, tile: 's2', kind: 'draw' }, scoresAfter: [2000, 2000, 2000, 2000], deltas,
    nextAction: { kind: 'draw', seat: ((seat + 1) % 4) as Seat },
    winners: [{ id: `r${id}`, batchId: `b${id}`, winner: seat, ordinal: id, sourceEventId: `s${id}`, score, deltas }] }
}
it('shows the first top-tier win fully, then ten repeats compactly without replaying duplicate IDs', () => {
  const queue = new BloodFlowPresentationQueue()
  for (let i = 0; i < 10; i++) {
    const event = batch(i + 1)
    queue.enqueue(event, i * 500); queue.enqueue(event, i * 500)
    const cue = queue.next(i * 500)!
    expect(cue.duration).toBe(i === 0 ? 1600 : 400)
    expect(cue.seats).toHaveLength(1)
    expect(queue.next(i * 500)).toBeNull()
  }
})
it('grades by base pattern weight, permits an upgrade and coalesces only visual backlog', () => {
  expect(winTier(batch(1, ['pinghu']).winners[0])).toBe(0)
  const queue = new BloodFlowPresentationQueue()
  queue.enqueue(batch(1, ['all-honors']), 0)
  expect(queue.next(0)?.duration).toBe(1400)
  queue.enqueue(batch(2), 500)
  expect(queue.next(500)?.duration).toBe(1600)
  const business = Array.from({ length: 20 }, (_, i) => batch(i + 3, ['mixed-suit'], (i % 4) as Seat))
  const before = JSON.stringify(business)
  business.forEach(b => queue.enqueue(b, 1000))
  const cue = queue.next(9000)!
  expect(cue.seats).toHaveLength(4)
  expect(cue.batchIds).toHaveLength(20)
  expect(cue.seats.map(s => s.mergedCount)).toEqual([5, 5, 5, 5])
  expect(JSON.stringify(business)).toBe(before)
  queue.reset(business)
  business.forEach(b => queue.enqueue(b, 10_000))
  expect(queue.next(10_000)).toBeNull()
})
