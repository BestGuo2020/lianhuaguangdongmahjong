import { TILE_TYPES } from '../core/rules/tiles'
import type { BloodFlowAiConfig } from '../variants/lotus/bloodFlow/config'
import { BLOOD_FLOW_CONFIG } from '../variants/lotus/bloodFlow/config'
import type { BloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import { visibleTiles } from '../variants/lotus/bloodFlow/seatView'
import { bloodFlowAiActions, bloodFlowSafetyExposure } from '../variants/lotus/bloodFlow/ai'
import { forecastSelfDrawIncome, forecastWinIncome } from '../variants/lotus/bloodFlow/incomeForecast'
import { isLastOpportunityRon, remainingNormalDraws } from '../variants/lotus/bloodFlow/winOpportunity'
import { bloodFlowDecisionPlan } from './bloodFlowDecisionInput'
import type { BloodFlowAction } from '../variants/lotus/bloodFlow/state'

export interface BloodFlowWinSafeguard {
  action: BloodFlowAction
  reason: 'verified-any-wait-reform' | 'last-ron-opportunity'
}

/** A narrow local policy, not a mathematical guarantee of game value. No hidden state is accepted. */
export function bloodFlowWinSafeguard(view: BloodFlowSeatView, config: BloodFlowAiConfig): BloodFlowWinSafeguard | null {
  if (!config.winOpportunityGuards || view.public.seats[view.seat].locked || !view.ownScore) return null
  const actions = bloodFlowAiActions(view, config)
  const win = actions.find(a => a.kind === 'win')
  if (!win) return null
  if (isLastOpportunityRon(view, config)) return { action: win, reason: 'last-ron-opportunity' }
  const player = view.players[view.seat]
  if (view.window?.kind !== 'turn' || view.window.source.kind !== 'draw'
    || view.window.source.seat !== view.seat || player.drawnTileIndex < 0
    || remainingNormalDraws(view, config.chainHorizon) < 2) return null
  const recommended = bloodFlowDecisionPlan(view, config).recommended
  if (recommended?.kind !== 'discard' || recommended.index === player.drawnTileIndex) return null
  const visible = visibleTiles(view)
  const risk = bloodFlowSafetyExposure(view, config, visible)(player.hand[recommended.index])
  // A warning about an expensive discard must not be overruled by an income-only check.
  if (risk > config.safetyCostNone) return null
  const locked = player.hand.filter((_, i) => i !== player.drawnTileIndex)
  const reformed = player.hand.filter((_, i) => i !== recommended.index)
  const before = TILE_TYPES.map(tile => forecastWinIncome(locked, player.melds, view.jokers, tile, 'self-draw'))
  const after = TILE_TYPES.map(tile => forecastWinIncome(reformed, player.melds, view.jokers, tile, 'self-draw'))
  if (!after.every(value => value > 0) || before.every(value => value > 0)
    || after.some((value, i) => value < before[i])) return null
  const future = (hand: typeof locked) => forecastSelfDrawIncome(hand, player.melds, view.jokers,
    visible, view.wallCount, config.chainHorizon, 4)
  const takeWin = view.ownScore.paymentPerPayer * 3 + future(locked)
  const reform = future(reformed) - risk
  if (reform < takeWin * config.reformGainRatio || reform - takeWin < BLOOD_FLOW_CONFIG.basePoints) return null
  return { action: recommended, reason: 'verified-any-wait-reform' }
}
