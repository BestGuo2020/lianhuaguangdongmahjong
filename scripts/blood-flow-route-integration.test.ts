import { expect, it } from 'vitest'
import { baseline, newRound, nextSeatToAct, submit } from './blood-flow-counterfactual'
import { opportunityPolicy } from './blood-flow-route-opportunity'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import { BLOOD_FLOW_AI } from '../src/game/variants/lotus/bloodFlow/config'

it('production decisions equal the independently validated policy across complete old/new trajectories', () => {
  let decisions = 0, changed = 0
  for (const policy of [baseline, opportunityPolicy]) for (const seed of [950002, 1000003, 1010053, 1080001]) {
    const engine = newRound(seed, seed === 950002 ? 1 : 0)
    let steps = 0
    while (!engine.result) {
      if (++steps > 2000) throw new Error('Integration replay stalled')
      const seat = nextSeatToAct(engine), view = bloodFlowSeatView(engine, seat)
      const reference = opportunityPolicy(view)
      const production = decideBloodFlowActionEv(view, { ...BLOOD_FLOW_AI, routeOpportunityGuard: true })
      expect(production).toEqual(reference)
      if (JSON.stringify(production) !== JSON.stringify(baseline(view))) changed++
      decisions++
      submit(engine, seat, policy(view)!)
    }
  }
  expect(decisions).toBeGreaterThan(500)
  expect(changed).toBeGreaterThan(0)
  console.log({ decisions, changed })
}, 180_000)
