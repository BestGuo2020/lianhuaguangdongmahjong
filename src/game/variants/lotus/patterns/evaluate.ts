import { TILE_TYPES } from '../../../core/rules/tiles'
import { BLOOD_FLOW_CONFIG } from '../bloodFlow/config'
import type { BloodFlowRuleConfig, WinEvaluation, WinEvaluationInput } from '../bloodFlow/types'
import { isWinningHand } from '../lotusRules'
import { matchPatterns } from './catalog'
import { validateWinInput, visitDecompositions } from './decompose'
import { compareScores, scorePatterns } from './score'

export function evaluateWin(input: WinEvaluationInput, config: BloodFlowRuleConfig = BLOOD_FLOW_CONFIG): WinEvaluation | null {
  if (!validateWinInput(input)) return null
  const external = input.source === 'discard' || input.source === 'robbed-kong'
  // Fast legality filter is the existing rules implementation, never a score cutoff.
  if (!isWinningHand([...input.concealed, input.winningTile], input.melds.length, [...input.jokers], external ? [input.winningTile] : [], ['white'])) return null
  let best: WinEvaluation | null = null
  visitDecompositions(input, decomposition => {
    const score = scorePatterns(matchPatterns(decomposition), decomposition.natural, input.source, input.opening, config)
    if (!best || compareScores(score, best.score) < 0) {
      best = { ruleVersion: config.version, decomposition, score,
        naturalEvidence: { allAssignmentsIdentity: decomposition.natural } }
    }
  })
  return best
}

/** The caller supplies only this seat's hand and public information. */
export function evaluateWaits(input: Omit<WinEvaluationInput, 'winningTile' | 'source' | 'opening'>) {
  return TILE_TYPES.flatMap(tile => {
    const selfDraw = evaluateWin({ ...input, winningTile: tile, source: 'self-draw', opening: null })?.score ?? null
    const discard = evaluateWin({ ...input, winningTile: tile, source: 'discard', opening: null })?.score ?? null
    return selfDraw || discard ? [{ tile, selfDraw, discard }] : []
  })
}
