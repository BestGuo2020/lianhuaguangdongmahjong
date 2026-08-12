export type RuleVariant = 'lotus-classic' | 'lotus-legacy'

export interface RuleVariantOption {
  id: RuleVariant
  name: string
  description: string
  highlights: string[]
  badge?: string
}

export const DEFAULT_RULE_VARIANT: RuleVariant = 'lotus-classic'

export const RULE_VARIANTS: readonly RuleVariantOption[] = [
  {
    id: 'lotus-classic',
    name: '莲花广麻',
    description: '莲花广麻现行规则',
    highlights: ['白板癞子', '仅自摸或抢杠胡', '胡后买 8 马'],
    badge: '默认',
  },
  {
    id: 'lotus-legacy',
    name: '莲花麻将',
    description: '旧版翻精规则',
    highlights: ['翻精癞子', '支持吃牌', '十三烂/七星/十三幺等胡型'],
    badge: '旧版',
  },
]

export function getRuleVariant(id: RuleVariant) {
  return RULE_VARIANTS.find((variant) => variant.id === id) ?? RULE_VARIANTS[0]
}
