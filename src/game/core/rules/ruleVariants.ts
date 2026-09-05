export type RuleVariant = 'lotus-classic' | 'lotus-legacy' | 'lotus-blood-flow'

export interface RuleVariantOption {
  id: RuleVariant
  name: string
  description: string
  highlights: string[]
  badge?: string
  /** Stable ruleset key used by local/remote engines and future modes. */
  rulesetId?: string
}

export const DEFAULT_RULE_VARIANT: RuleVariant = 'lotus-classic'

export const RULE_VARIANTS: readonly RuleVariantOption[] = [
  {
    id: 'lotus-classic',
    name: '莲花广麻',
    description: '莲花广麻现行规则',
    highlights: ['白板癞子', '仅自摸或抢杠胡', '胡后买 8 马'],
    badge: '默认',
    rulesetId: 'lotus-classic',
  },
  {
    id: 'lotus-legacy',
    name: '莲花麻将',
    description: '旧版翻精规则',
    highlights: ['翻精癞子', '支持吃牌', '十三烂/七星/十三幺等胡型'],
    badge: '',
    rulesetId: 'lotus-legacy',
  },
]

export function getRuleVariant(id: RuleVariant) {
  if (id === 'lotus-blood-flow') return BLOOD_FLOW_RULE
  const variant = RULE_VARIANTS.find((variant) => variant.id === id)
  if (!variant) throw new Error(`Unknown ruleset: ${id}`)
  return variant
}

export const BLOOD_FLOW_RULE: RuleVariantOption = {
  id: 'lotus-blood-flow', name: '莲花麻将·血流', description: '翻精血流规则',
  highlights: ['多次胡牌', '首胡锁手', '硬胡 ×2 · 单家 64 倍封顶'], badge: '测试', rulesetId: 'lotus-blood-flow',
}
