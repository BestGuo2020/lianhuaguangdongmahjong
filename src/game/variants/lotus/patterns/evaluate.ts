import { TILE_TYPES } from '../../../core/rules/tiles'
import { BLOOD_FLOW_CONFIG } from '../bloodFlow/config'
import type { BloodFlowRuleConfig, WinEvaluation, WinEvaluationInput } from '../bloodFlow/types'
import { isAnyWait, isWinningHand } from '../lotusRules'
import { matchPatterns } from './catalog'
import { validateWinInput, visitDecompositions } from './decompose'
import { compareScores, scorePatterns } from './score'
import type { WinningDecomposition } from './types'

// The same fixed hand is scored for all 34 tiles by income forecasts and wait previews.
const selfDrawOnlyCache = new Map<string, boolean>()
function selfDrawOnly(input: WinEvaluationInput): boolean {
  const key = JSON.stringify([[...input.concealed].sort(), input.melds.length, [...input.jokers].sort()])
  const cached = selfDrawOnlyCache.get(key)
  if (cached !== undefined) return cached
  const result = isAnyWait([...input.concealed], input.melds.length, [...input.jokers], ['white'])
  if (selfDrawOnlyCache.size >= 20_000) selfDrawOnlyCache.delete(selfDrawOnlyCache.keys().next().value!)
  selfDrawOnlyCache.set(key, result)
  return result
}

/** 杠加成统计：风杠（字牌杠）单列；其余按是否暗成区分。 */
function kongCountsOf(decomposition: WinningDecomposition) {
  let exposed = 0, concealed = 0, wind = 0
  for (const group of decomposition.groups) {
    if (group.kind === 'wind-kong') wind += 1
    else if (group.kind === 'kong') { if (group.concealed) concealed += 1; else exposed += 1 }
  }
  return { exposed, concealed, wind }
}

export function evaluateWin(input: WinEvaluationInput, config: BloodFlowRuleConfig = BLOOD_FLOW_CONFIG): WinEvaluation | null {
  if (!validateWinInput(input)) return null
  const external = input.source === 'discard' || input.source === 'robbed-kong'
  // Fast legality filter is the existing rules implementation, never a score cutoff.
  if (!isWinningHand([...input.concealed, input.winningTile], input.melds.length, [...input.jokers], external ? [input.winningTile] : [], ['white'])) return null
  // 精吊任意听与普通翻精一致：吃胡（含地胡）和抢杠均禁止；杠开属于自摸。
  if (external && selfDrawOnly(input)) return null
  let best: WinEvaluation | null = null
  visitDecompositions(input, decomposition => {
    const score = scorePatterns(matchPatterns(decomposition), decomposition.natural, input.source, input.opening, config,
      kongCountsOf(decomposition))
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
