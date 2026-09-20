/** Offline experiment, not a production policy. One future own draw, then one
 * optional hand exchange, fixed-hand self-draw leaf value. Not a full game tree. */
import { bloodFlowEvContext } from '../src/game/variants/lotus/bloodFlow/evContext'
import { decideBloodFlowActionEv, bloodFlowAiActions } from '../src/game/variants/lotus/bloodFlow/ai'
import { forecastSelfDrawIncome, forecastWinIncome, ownDrawOpportunities, unseenCounts } from '../src/game/variants/lotus/bloodFlow/incomeForecast'
import { visibleTiles, type BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { waitingTilesCached } from '../src/game/variants/lotus/bloodFlow/patternPotentials'
import { PANEL_CURRENT_CONFIG } from './blood-flow-opponent-panel'
import type { TileType } from '../src/game/core/contracts/types'
import { BLOOD_FLOW_CONFIG } from '../src/game/variants/lotus/bloodFlow/config'
import { TILE_TYPES } from '../src/game/core/rules/tiles'
import { isWinningHand } from '../src/game/variants/lotus/lotusRules'

export const FORECAST_CONFIG = Object.freeze({ ...PANEL_CURRENT_CONFIG, chainForecast: 'self-draw-v1' as const })
export const forecastPolicy = (view: BloodFlowSeatView) => decideBloodFlowActionEv(view, FORECAST_CONFIG)

export function boundedSearch(view: BloodFlowSeatView, prune = true) {
  const fallback = forecastPolicy(view)
  const p = view.players[view.seat]
  if (view.public.seats[view.seat].locked || view.window?.kind !== 'turn'
    || !view.ownActions.some(a => a.kind === 'win') || fallback?.kind !== 'win'
    || ownDrawOpportunities(view.wallCount, FORECAST_CONFIG.chainHorizon) < 2) return { action: fallback, nodes: 0 }
  const ev = bloodFlowEvContext(view, FORECAST_CONFIG)
  const allowed = bloodFlowAiActions(view, FORECAST_CONFIG)
  const candidate = ev.reformCandidates.find(c => allowed.some(a => a.kind === 'discard' && a.index === c.index))
  if (!candidate) return { action: fallback, nodes: 0 }
  // Only the highest fixed-hand candidate is expanded; deterministic top-1 beam.
  const hand = p.hand.filter((_, i) => i !== candidate.index)
  const visible = visibleTiles(view), counts = unseenCounts(visible)
  const unseen = counts.reduce((n, e) => n + e.count, 0)
  if (!unseen) return { action: fallback, nodes: 0 }
  let nodes = 0, value = 0
  // Incoming A then B and incoming B then A complete the same 14-tile hand.
  // Reuse legality across those branches, not just identical 13-tile waits.
  const complete = new Map<string,boolean>()
  const searchWaits = (after: TileType[]) => !prune ? waitingTilesCached(after,p.melds.length,view.jokers)
    : TILE_TYPES.filter(tile=>{
      const full=[...after,tile],key=[...full].sort().join(',')
      let legal=complete.get(key)
      if(legal===undefined){legal=isWinningHand(full,p.melds.length,[...view.jokers],[],['white']);complete.set(key,legal)}
      return legal
    })
  const remainingHorizon = FORECAST_CONFIG.chainHorizon - 1
  for (const { tile, count } of counts) {
    if (!count) continue
    const nextVisible = [...visible, tile], drawn = [...hand, tile]
    const nextCounts = unseenCounts(nextVisible)
    const leaf = (after: readonly TileType[]) => {
      nodes++
      return forecastSelfDrawIncome(after, p.melds, view.jokers, nextVisible,
        view.wallCount - 4, remainingHorizon)
    }
    const income = forecastWinIncome(hand, p.melds, view.jokers, tile, 'self-draw')
    const stay = leaf(hand)
    let best = stay + income
    // Beam selection uses public remaining waits, not labels or hidden rollouts.
    const seen = new Set<TileType>()
    const exchanges = drawn.flatMap((discard, index) => {
      if (discard === tile || seen.has(discard)) return []
      seen.add(discard)
      const after = drawn.filter((_, i) => i !== index)
      const waits = searchWaits(after)
      const mass = nextCounts.reduce((n, e) => n + (waits.includes(e.tile) ? e.count : 0), 0)
      return mass ? [{ after, mass, index }] : []
    }).sort((a, b) => b.mass - a.mass || a.index - b.index)
    if (exchanges[0]) {
      // An admissible bound: every possible wait pays the per-payer rule cap.
      // Only skip exact scoring when even that cannot beat the incumbent.
      const upper = ownDrawOpportunities(view.wallCount - 4, remainingHorizon)
        * exchanges[0].mass / Math.max(1, unseen - 1)
        * BLOOD_FLOW_CONFIG.basePoints * BLOOD_FLOW_CONFIG.maxMultiplierPerPayer * 3
      if (!prune || upper > best) best = Math.max(best, leaf(exchanges[0].after))
    }
    value += count / unseen * best
  }
  // At most 34 chance outcomes * 2 terminal hands; no partial-tree promotion.
  if (nodes > 68) throw new Error('Search node budget exceeded')
  return { action: value >= ev.winEv * FORECAST_CONFIG.reformGainRatio
    ? { kind: 'discard' as const, index: candidate.index } : fallback, nodes, value, winEv: ev.winEv }
}
