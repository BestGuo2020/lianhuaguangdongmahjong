import { BLOOD_FLOW_CONFIG } from '../bloodFlow/config'
import type { BloodFlowRuleConfig, PublicWinScore, WinSource } from '../bloodFlow/types'
import type { PatternId } from './types'

/**
 * 杠加成（2026-09-12 新增）：每个**明杠 +1**、**暗杠/风杠 +2**，直接加到番型倍率上。
 * 此前杠没有任何番型收益，这正是三杠/四杠做不出来的根因之一。
 */
export interface KongCounts { readonly exposed: number; readonly concealed: number; readonly wind: number }

export function kongBonusOf(counts: KongCounts, config: BloodFlowRuleConfig = BLOOD_FLOW_CONFIG): number {
  const bonus = (config as { kongBonus?: { exposed: number; concealed: number; wind: number } }).kongBonus
    ?? { exposed: 1, concealed: 2, wind: 2 }
  return counts.exposed * bonus.exposed + counts.concealed * bonus.concealed + counts.wind * bonus.wind
}

export function scorePatterns(patterns: readonly PatternId[], natural: boolean, source: WinSource,
  opening: 'heaven' | 'earth' | null = null, config: BloodFlowRuleConfig = BLOOD_FLOW_CONFIG,
  kongs: KongCounts = { exposed: 0, concealed: 0, wind: 0 }): PublicWinScore {
  const ids = [...new Set(patterns)].sort()
  const excluded = ids.flatMap(id => {
    const includedBy = ids.find(other => config.patterns[other].excludes.includes(id))
    return includedBy ? [{ id, includedBy }] : []
  })
  const items = ids.filter(id => !excluded.some(e => e.id === id))
    .map(id => { const { label, weight } = config.patterns[id]; return { id, label, weight } })
  // 三杠/四杠本身就是"把杠算进去"的番种 → 此时不再叠加每副杠的加成（避免重复奖励同一个结构）。
  const kongPatternScored = items.some(item => item.id === 'three-kongs' || item.id === 'four-kongs')
  const kongBonus = kongPatternScored ? 0 : kongBonusOf(kongs, config)
  const patternMultiplier = 1 + items.reduce((sum, p) => sum + p.weight - 1, 0) + kongBonus
  const eventMultiplier = config.eventMultipliers[source]
  const ordinary = patternMultiplier * eventMultiplier
  const openingApplied = opening !== null && ordinary < config.openingMinimumMultiplier
  const uncappedMultiplier = (openingApplied ? config.openingMinimumMultiplier : ordinary)
    * (natural ? config.hardWinMultiplier : 1)
  const finalMultiplier = Math.min(uncappedMultiplier, config.maxMultiplierPerPayer)
  return { items, excluded, hardWin: natural, source, opening, patternMultiplier, eventMultiplier, kongBonus,
    openingApplied, uncappedMultiplier, finalMultiplier, capped: uncappedMultiplier > finalMultiplier,
    paymentPerPayer: config.basePoints * finalMultiplier }
}

/** Negative means a wins. Never lend the natural flag to another decomposition. */
export function compareScores(a: PublicWinScore, b: PublicWinScore): number {
  return b.paymentPerPayer - a.paymentPerPayer || Number(b.hardWin) - Number(a.hardWin)
    || stableCompare(a.items.map(p => p.id).join(','), b.items.map(p => p.id).join(','))
}

export function stableCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
