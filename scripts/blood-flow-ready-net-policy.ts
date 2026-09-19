import { BLOOD_FLOW_AI } from '../src/game/variants/lotus/bloodFlow/config'
import { decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import type { Policy } from './blood-flow-counterfactual'
import type { BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'

export const READY_CONTROL_CONFIG = Object.freeze({ ...BLOOD_FLOW_AI, routeOpportunityGuard: true,
  claimMeldProjection: true, claimReadyNetGuard: false })
export const READY_CANDIDATE_CONFIG = Object.freeze({ ...READY_CONTROL_CONFIG, claimReadyNetGuard: true })
export const readyControl: Policy = view => decideBloodFlowActionEv(view, READY_CONTROL_CONFIG)
export const readyCandidate: Policy = view => decideBloodFlowActionEv(view, READY_CANDIDATE_CONFIG)
/** The flag is consumed only by unlocked discard-claim chi/peng evaluation. Exact computation shortcut. */
export const readyCanDiffer = (view: BloodFlowSeatView) => !view.public.seats[view.seat].locked
  && view.window?.kind !== 'turn' && view.window?.source.kind === 'discard'
  && view.ownActions.some(a => a.kind === 'chi' || a.kind === 'peng')
