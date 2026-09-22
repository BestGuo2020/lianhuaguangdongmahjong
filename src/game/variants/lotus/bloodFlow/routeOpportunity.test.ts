import { expect, it } from 'vitest'
import fixtures from './routeOpportunity.fixture.json'
import type { BloodFlowSeatView } from './seatView'
import { decideBloodFlowActionEv } from './ai'
import { BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI } from './config'

// Reproduce the historical trajectory with its original forecast, independent of production upgrades.
const old = { ...BLOOD_FLOW_AI, chainForecast: 'legacy' as const, opportunityCalibration: undefined,
  routeOpportunityGuard: false, claimMeldProjection: false, claimReadyNetGuard: false }
const enabled = { ...old, routeOpportunityGuard: true }
// Captured with the unmodified 2aa238b estimator. No opponents' concealed hands or future wall.
// Loading fixed views prevents unrelated strategy fixes from changing the historical trajectory.
const cases = new Map(fixtures.cases.map(raw => {
  const view=structuredClone(raw) as unknown as BloodFlowSeatView
  return [view.seat,view]
}))

it('recovers the two proven late wins and has an exact per-call rollback', () => {
  for (const view of cases.values()) {
    const before = structuredClone(view)
    expect(decideBloodFlowActionEv(view, old)).toEqual({ kind: 'discard', index: view.players[view.seat].hand.indexOf('p6') })
    expect(decideBloodFlowActionEv(view, enabled)).toEqual({ kind: 'win' })
    expect(decideBloodFlowActionEv(view, { ...enabled, routeOpportunityGuard: false })).toEqual(decideBloodFlowActionEv(view, old))
    expect(view).toEqual(before)
  }
})

it('preserves enough-wall, locked, non-win and claim behavior', () => {
  const view = cases.get(0)!
  const locked = structuredClone(view)
  Object.assign(locked.public.seats[view.seat], { locked: true })
  const variants: BloodFlowSeatView[] = [
    { ...view, wallCount: 20 }, locked,
    { ...view, ownActions: view.ownActions.filter(a => a.kind !== 'win'), ownScore: null },
    { ...view, window: { ...view.window!, kind: 'win', source: { ...view.window!.source, kind: 'discard' } } },
  ]
  for (const variant of variants) expect(decideBloodFlowActionEv(variant, enabled)).toEqual(decideBloodFlowActionEv(variant, old))
})

it('also releases the late win to the current forecast instead of forcing a route discard', () => {
  for (const view of cases.values()) {
    const withoutRoute = { ...BLOOD_FLOW_AI, bigHandRoute: { ...BLOOD_FLOW_AI.bigHandRoute, mode: 'off' as const } }
    expect(decideBloodFlowActionEv(view, BLOOD_FLOW_AI)).toEqual(decideBloodFlowActionEv(view, withoutRoute))
  }
})

it('keeps the unvalidated LLM configuration opted out and honors the build rollback', () => {
  expect(BLOOD_FLOW_LLM_AI.routeOpportunityGuard).toBe(false)
  expect(BLOOD_FLOW_AI.routeOpportunityGuard).toBe(import.meta.env.VITE_BLOOD_FLOW_ROUTE_OPPORTUNITY !== 'off')
})
