import { BLOOD_FLOW_CONFIG } from '../bloodFlow/config'
import type { BloodFlowRuleConfig, PublicWinScore, WinSource } from '../bloodFlow/types'
import type { PatternId } from './types'

/**
 * 杠加成（2026-09-12 新增；2026-09-15 风杠降到与明杠同档）：每个**明杠 +1**、**风杠 +1**、
 * **暗杠 +2**，直接加到番型倍率上。
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
  // 2026-09-15 口径变更：`1 + Σ(番值−1)` → **Σ(番值)**。
  // 原口径下"1 番"等于"不加成"（底数就是 1 番），新增的 1 番番种（门清/平胡）会完全无效。
  // 于是：鸡胡兜底 0.5 番、门清 1 番、平胡 1 番、门清+平胡 2 番（与旧门清平胡一致）、
  // 清一色仍 8 番、门清+清一色 9 番。
  //
  // 但**倍率必须是整数**（协议 `isPublicWinScore` 用 int() 校验倍率与点数，0.5 会让整包被客机拒收），
  // 所以鸡胡的"半番"不落在倍率上，而是落在**支付减半**（`halfPayment`）上：
  // 只有鸡胡（Σ 番值 < 1，即没有任何计分番种）时 rawSum = 0.5 → 倍率取 max(1, 0.5) = 1、
  // 点数 = 底分 × 倍率 ÷ 2 = 5（自摸/硬胡等整倍后仍是整数）。
  // 鸡胡遇到杠（2026-09-15 用户定案）：**鸡胡不与任何番型叠加，包括大明杠/暗杠/风杠**。
  // 开杠后"只是把鸡胡的番型提升成了杠的番型"——**只算杠番，不加鸡胡那 0.5 番**，
  // 也不再有兜底的 1 番基数；但**番型名字仍叫鸡胡**（items 保持 ['chicken']，便于结算显示）。
  // 杠杆的**即时杠分**（20/40/80 点，见 kongPayments）不受影响，仍然照付。
  const chickenOnly = items.length === 1 && items[0].id === 'chicken' && !kongPatternScored
  const kongOnlyChicken = chickenOnly && kongBonus > 0
  const rawSum = items.reduce((sum, p) => sum + p.weight, 0)
  // 纯鸡胡 → 0.5 番落在"支付减半"上；鸡胡+杠 → 倍率就等于杠番本身。
  const halfPayment = chickenOnly && !kongOnlyChicken && rawSum < 1
  const patternMultiplier = kongOnlyChicken ? kongBonus : Math.max(1, rawSum) + kongBonus
  const eventMultiplier = config.eventMultipliers[source]
  const ordinary = patternMultiplier * eventMultiplier
  const openingApplied = opening !== null && ordinary < config.openingMinimumMultiplier
  const uncappedMultiplier = (openingApplied ? config.openingMinimumMultiplier : ordinary)
    * (natural ? config.hardWinMultiplier : 1)
  const finalMultiplier = Math.min(uncappedMultiplier, config.maxMultiplierPerPayer)
  return { items, excluded, hardWin: natural, source, opening, patternMultiplier, eventMultiplier, kongBonus, halfPayment,
    openingApplied, uncappedMultiplier, finalMultiplier, capped: uncappedMultiplier > finalMultiplier,
    paymentPerPayer: (config.basePoints * finalMultiplier) / (halfPayment ? 2 : 1) }
}

/** Negative means a wins. Never lend the natural flag to another decomposition. */
export function compareScores(a: PublicWinScore, b: PublicWinScore): number {
  return b.paymentPerPayer - a.paymentPerPayer || Number(b.hardWin) - Number(a.hardWin)
    || stableCompare(a.items.map(p => p.id).join(','), b.items.map(p => p.id).join(','))
}

export function stableCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
