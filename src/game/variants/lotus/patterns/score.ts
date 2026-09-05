import { BLOOD_FLOW_CONFIG } from '../bloodFlow/config'
import type { BloodFlowRuleConfig, PublicWinScore, WinSource } from '../bloodFlow/types'
import type { PatternId } from './types'

export function scorePatterns(patterns: readonly PatternId[], natural: boolean, source: WinSource,
  opening: 'heaven' | 'earth' | null = null, config: BloodFlowRuleConfig = BLOOD_FLOW_CONFIG): PublicWinScore {
  const ids = [...new Set(patterns)].sort()
  const excluded = ids.flatMap(id => {
    const includedBy = ids.find(other => config.patterns[other].excludes.includes(id))
    return includedBy ? [{ id, includedBy }] : []
  })
  const items = ids.filter(id => !excluded.some(e => e.id === id))
    .map(id => { const { label, weight } = config.patterns[id]; return { id, label, weight } })
  const patternMultiplier = 1 + items.reduce((sum, p) => sum + p.weight - 1, 0)
  const eventMultiplier = config.eventMultipliers[source]
  const ordinary = patternMultiplier * eventMultiplier
  const openingApplied = opening !== null && ordinary < config.openingMinimumMultiplier
  const uncappedMultiplier = (openingApplied ? config.openingMinimumMultiplier : ordinary)
    * (natural ? config.hardWinMultiplier : 1)
  const finalMultiplier = Math.min(uncappedMultiplier, config.maxMultiplierPerPayer)
  return { items, excluded, hardWin: natural, source, opening, patternMultiplier, eventMultiplier,
    openingApplied, uncappedMultiplier, finalMultiplier, capped: uncappedMultiplier > finalMultiplier,
    paymentPerPayer: config.basePoints * finalMultiplier }
}

/** Negative means a wins. Never lend the natural flag to another decomposition. */
export function compareScores(a: PublicWinScore, b: PublicWinScore): number {
  return b.paymentPerPayer - a.paymentPerPayer || Number(b.hardWin) - Number(a.hardWin)
    || stableCompare(a.items.map(p => p.id).join(','), b.items.map(p => p.id).join(','))
}

export function stableCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
