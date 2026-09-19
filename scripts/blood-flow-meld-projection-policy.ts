import { BLOOD_FLOW_AI } from '../src/game/variants/lotus/bloodFlow/config'
import { decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import type { Policy } from './blood-flow-counterfactual'

// Both arms retain the previously validated opportunity guard. Only projection differs.
export const MELD_CONTROL_CONFIG = Object.freeze({ ...BLOOD_FLOW_AI, routeOpportunityGuard: true, claimMeldProjection: false, claimReadyNetGuard: false })
export const MELD_FIXED_CONFIG = Object.freeze({ ...MELD_CONTROL_CONFIG, claimMeldProjection: true })
export const meldControl: Policy = view => decideBloodFlowActionEv(view, MELD_CONTROL_CONFIG)
export const meldFixed: Policy = view => decideBloodFlowActionEv(view, MELD_FIXED_CONFIG)
