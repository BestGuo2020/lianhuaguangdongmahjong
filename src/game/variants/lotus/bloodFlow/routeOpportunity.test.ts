import { beforeAll, expect, it } from 'vitest'
import { BloodFlowEngine } from './engine'
import { bloodFlowSeatView, type BloodFlowSeatView } from './seatView'
import { decideBloodFlowActionEv } from './ai'
import { BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI } from './config'
import { seededRandom } from './simulation'
import { SEATS } from './state'

const old = { ...BLOOD_FLOW_AI, routeOpportunityGuard: false, claimMeldProjection: false }
const enabled = { ...old, routeOpportunityGuard: true }
const cases = new Map<number, BloodFlowSeatView>()
beforeAll(() => {
  const engine = new BloodFlowEngine({ authorityEpoch: 'route-regression', roundId: 'case', dealer: 1,
    random: seededRandom(950002), now: () => 0, winBeatMs: 0 })
  let steps = 0
  while (!engine.result) {
    if (++steps > 2000) throw new Error('Regression fixture stalled')
    const seat = SEATS.find(s => engine.window!.options[s].length && !engine.window!.decisions[s])!
    const view = bloodFlowSeatView(engine, seat)
    if (!view.public.seats[seat].locked && view.ownActions.some(a => a.kind === 'win')
      && ((seat === 0 && view.wallCount === 3) || (seat === 2 && view.wallCount === 13))) cases.set(seat, view)
    expect(engine.submit(engine.command(seat, decideBloodFlowActionEv(view, old)!))).toBe(true)
  }
  expect(cases.size).toBe(2)
}, 30_000)

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

it('keeps the unvalidated LLM configuration opted out and honors the build rollback', () => {
  expect(BLOOD_FLOW_LLM_AI.routeOpportunityGuard).toBe(false)
  expect(BLOOD_FLOW_AI.routeOpportunityGuard).toBe(import.meta.env.VITE_BLOOD_FLOW_ROUTE_OPPORTUNITY !== 'off')
})
