import { BLOOD_FLOW_KONG_BONUS } from '../../game/variants/lotus/bloodFlow/config'
import type { KongLedgerEntry, PublicWinScore } from '../../game/variants/lotus/bloodFlow/types'

export interface ScoreCardItem { id: string; label: string; weight: number }
export interface ScoreCardKongContext {
  winner: number
  sequence: number
  events: readonly KongLedgerEntry[]
}

/** Display only: preserve score.items for the win title and effects. */
export function bloodFlowScoreCardItems(score: PublicWinScore, context?: ScoreCardKongContext): ScoreCardItem[] {
  const bonus = score.kongBonus ?? 0
  const chickenWithKong = bonus > 0 && score.items.length === 1 && score.items[0].id === 'chicken'
  const items: ScoreCardItem[] = chickenWithKong ? [] : [...score.items]
  if (bonus > 0) {
    const weights = { exposed: 0, concealed: 0, wind: 0 }
    const seen = new Set<string>()
    for (const event of context?.events ?? []) {
      // Later kongs must never change an earlier win's scoring details.
      if (event.actor !== context!.winner || event.sequence >= context!.sequence || seen.has(event.id)) continue
      seen.add(event.id)
      const kind = event.kongKind === 'discard' || event.kongKind === 'added' ? 'exposed' : event.kongKind
      weights[kind] += BLOOD_FLOW_KONG_BONUS[kind]
    }
    if (weights.exposed + weights.concealed + weights.wind === bonus) {
      for (const kind of ['exposed', 'concealed', 'wind'] as const) {
        if (weights[kind] > 0) items.push({ id: `kong-${kind}`, label: { exposed: '明杠', concealed: '暗杠', wind: '风杠' }[kind], weight: weights[kind] })
      }
    } else {
      // Older records may carry only the aggregate: do not guess the kong kind.
      items.push({ id: 'kong-bonus', label: '杠加成', weight: bonus })
    }
  }
  return items.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
}
