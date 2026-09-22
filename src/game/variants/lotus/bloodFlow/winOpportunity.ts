import type { BloodFlowAiConfig } from './config'
import type { BloodFlowSeatView } from './seatView'
import { ownDrawOpportunities } from './incomeForecast'

/** Normal rotation estimate, not a guarantee: melds/kongs can change turn order. */
export function remainingNormalDraws(view: BloodFlowSeatView, horizon: number): number {
  const from = view.window?.source.seat ?? view.seat
  const offset = ((view.seat - from + 4) % 4) || 4
  return ownDrawOpportunities(view.wallCount, horizon, offset)
}

/** Only a plain ron choice; never bypass meld priority, rob-kong valuation or self-draw reform. */
export function isLastOpportunityRon(view: BloodFlowSeatView, config: BloodFlowAiConfig): boolean {
  return config.winOpportunityGuards === true && !view.public.seats[view.seat].locked
    && view.window?.kind !== 'turn' && view.window?.source.kind === 'discard'
    && view.window.source.seat !== view.seat && view.ownScore?.source === 'discard'
    && view.ownScore.paymentPerPayer > 0 && view.wallCount <= config.lateGameWallCount
    && view.ownActions.some(a => a.kind === 'win')
    && view.ownActions.every(a => a.kind === 'win' || a.kind === 'pass')
    && remainingNormalDraws(view, 2) <= 1
}
