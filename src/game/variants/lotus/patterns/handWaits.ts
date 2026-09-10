import type { TileType } from '../../../core/contracts/types'
import type { WinEvaluationInput } from '../bloodFlow/types'
import { evaluateWaits } from './evaluate'

export type HandWaitInput = Omit<WinEvaluationInput, 'winningTile' | 'source' | 'opening'> & {
  drawnTileIndex: number
  locked: boolean
}
export type WaitScores = ReturnType<typeof evaluateWaits>
export interface HandWaitHints {
  current: WaitScores
  discards: { discard: TileType; waits: WaitScores }[]
}

/** The existing evaluator supplies all three shared hint contracts, off-thread.
 * Counts of unseen tiles are deliberately left to the current public view. */
export function evaluateHandWaits(input: HandWaitInput): HandWaitHints {
  const { concealed, melds, jokers, drawnTileIndex, locked } = input
  const size = concealed.length + melds.length * 3
  if (size === 13) return { current: evaluateWaits({ concealed, melds, jokers }), discards: [] }
  if (size !== 14) return { current: [], discards: [] }
  const seen = new Set<TileType>()
  const discards: HandWaitHints['discards'] = []
  concealed.forEach((discard, index) => {
    if (locked && index !== drawnTileIndex || seen.has(discard)) return
    seen.add(discard)
    const hand = concealed.filter((_, i) => i !== index)
    const waits = evaluateWaits({ concealed: hand, melds, jokers })
    if (waits.length) discards.push({ discard, waits })
  })
  // A draw preserves the previous waiting hand. Chi/peng have no drawn tile:
  // there are only discard options until the player actually discards.
  return { current: discards.find(item => item.discard === concealed[drawnTileIndex])?.waits ?? [], discards }
}
