import { beforeAll, expect, it } from 'vitest'
import { baseline, newRound, nextSeatToAct, submit } from './blood-flow-counterfactual'
import { opportunityDecision, opportunityGate, pairedContest } from './blood-flow-route-opportunity'
import { bloodFlowSeatView, type BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'

const cases = new Map<number, BloodFlowSeatView>()
beforeAll(() => {
  // Rebuild recorded counterexamples from their seed; no dependency on ignored work/ files.
  const engine = newRound(950002, 1)
  let steps = 0
  while (!engine.result) {
    if (++steps > 2000) throw new Error('Fixture stalled')
    const seat = nextSeatToAct(engine), view = bloodFlowSeatView(engine, seat)
    if (view.ownActions.some(a => a.kind === 'win') && !view.public.seats[seat].locked
      && ((seat === 0 && view.wallCount === 3) || (seat === 2 && view.wallCount === 13))) cases.set(seat, view)
    submit(engine, seat, baseline(view)!)
  }
  expect(cases.size).toBe(2)
}, 120_000)

it('retains win at both recorded late route counterexamples without changing legal actions', () => {
  for (const view of cases.values()) {
    const before = structuredClone(view)
    expect(baseline(view)?.kind).toBe('discard')
    const result = opportunityDecision(view)
    expect(result.gate?.route).toBe('allTriplets')
    expect(result.action).toEqual({ kind: 'win' })
    expect(view.ownActions).toContainEqual(result.action)
    expect(view).toEqual(before)
  }
})

it('leaves enough-wall, locked, non-win and external-win windows outside the experiment', () => {
  const view = cases.get(0)!
  expect(opportunityGate({ ...view, wallCount: 20 })).toBeNull()
  expect(opportunityGate({ ...view, ownActions: view.ownActions.filter(a => a.kind !== 'win') })).toBeNull()
  expect(opportunityGate({ ...view, window: { ...view.window!, kind: 'win', source: { ...view.window!.source, kind: 'discard' } } })).toBeNull()
  const locked = structuredClone(view)
  Object.assign(locked.public.seats[view.seat], { locked: true })
  expect(opportunityGate(locked)).toBeNull()
})

it('common-prefix reuse is identical to full replay, including score carry, seat rotation and diagnostics', () => {
  const optimized = pairedContest(950101, 4, true)
  const replayed = pairedContest(950101, 4, false)
  expect(optimized.rows.some(row => row.diverged)).toBe(true)
  expect(optimized.rows).toEqual(replayed.rows)
  expect(optimized.controlNet).toEqual(replayed.controlNet)
  expect(optimized.actualCommands).toBeLessThan(replayed.actualCommands)
}, 240_000)

it('full-match A/A has zero paired increment in all seats', () => {
  const result = pairedContest(950102, 4, true, baseline)
  expect(result.rows.map(r => r.deltaVsControl)).toEqual([0, 0, 0, 0])
  expect(result.rows.reduce((sum, r) => sum + r.net, 0)).toBe(0)
  expect(result.rows.every(r => r.roundNet.length === 4)).toBe(true)
}, 120_000)
