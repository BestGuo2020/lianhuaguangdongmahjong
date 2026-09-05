import { expect, it } from 'vitest'
import { BloodFlowPresentationQueue, cuePhase, winTier } from './presentation'
import { BloodFlowPresentationDirector } from './presentationDirector'
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
    expect(cue.duration).toBe(2600)
    expect(cue.compact).toBe(i !== 0)
    expect(cue.seats).toHaveLength(1)
    expect(queue.next(i * 500)).toBeNull()
  }
})
it('keeps full-effect cooldown by seat and main pattern, and aggregates every included payment',()=>{
  const queue=new BloodFlowPresentationQueue()
  queue.enqueue(batch(1),0);expect(queue.next(0)?.compact).toBe(false)
  queue.enqueue(batch(2,['all-green'],1),200);expect(queue.next(200)?.compact).toBe(false)
  queue.enqueue(batch(3),300);expect(queue.next(300)?.compact).toBe(true)
  const merged=Array.from({length:5},(_,i)=>batch(10+i,['mixed-suit'],0))
  merged.forEach(b=>queue.enqueue(b,500))
  const cue=queue.next(500)!
  expect(cue.deltas).toEqual([0,1,2,3].map(s=>merged.reduce((n,b)=>n+b.deltas[s],0)))
  expect(cue.records).toHaveLength(5);expect(cue.flights).toHaveLength(1);expect(cue.title).toContain('合计')
})
it('the single viewer director owns cue time and restores history without replay',()=>{
  const director=new BloodFlowPresentationDirector(),event=batch(1)
  director.sync([],'round-1',0);director.sync([event],'round-1',100)
  const cue=director.tick(120)!
  expect(cue.startedAt).toBe(120);expect(director.tick(200)).toBe(cue)
  expect(cuePhase(cue,120+cue.phaseMarks.impact)).toBe('impact')
  expect(director.hiddenRecordIds(200)).toContain('r1')
  expect(director.hiddenRecordIds(120+cue.phaseMarks.readable)).toEqual([])
  expect(director.tick(120+cue.duration)).toBeNull()
  director.sync([event],'restored',2000);expect(director.tick(2000)).toBeNull();expect(director.busy).toBe(false)
})
it('orders kong receipts with win batches and never replays the same receipt',()=>{
  const director=new BloodFlowPresentationDirector(),win=batch(3)
  const kong={kind:'kong' as const,id:'k2',authorityEpoch:'test',roundId:'1',sequence:2,actor:1 as const,kongKind:'concealed' as const,sourceSeat:null,
    deltas:[-20,60,-20,-20] as const,scoresAfter:[1980,2060,1980,1980] as const}
  director.sync([],'r',0);director.sync([win],'r',100,[kong])
  const cue=director.tick(100)!
  expect(cue.kind).toBe('kong');expect(cue.deltas).toEqual(kong.deltas);expect(cue.flights).toEqual([])
  director.sync([win],'r',200,[kong]);expect(director.tick(800)?.id).toBe(win.batchId)
  expect(director.tick(3400)).toBeNull()
  director.sync([win],'restore',4000,[kong]);expect(director.tick(4000)).toBeNull()
})
it('grades by base pattern weight, permits an upgrade and coalesces only visual backlog', () => {
  expect(winTier(batch(1, ['pinghu']).winners[0])).toBe(0)
  const queue = new BloodFlowPresentationQueue()
  queue.enqueue(batch(1, ['all-honors']), 0)
  expect(queue.next(0)?.duration).toBe(2300)
  queue.enqueue(batch(2), 500)
  expect(queue.next(500)?.duration).toBe(2600)
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
