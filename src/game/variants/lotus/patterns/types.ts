import type { TileType } from '../../../core/contracts/types'

export type RegularPatternId =
  | 'pure-suit' | 'mixed-suit' | 'all-triplets'
  | 'little-three-dragons' | 'big-three-dragons'
  | 'little-four-winds' | 'big-four-winds' | 'nine-gates'
  | 'all-green' | 'pure-terminals' | 'mixed-terminals'
  | 'three-concealed-triplets' | 'four-concealed-triplets'
  | 'all-honors' | 'three-kongs' | 'four-kongs'
  // 2026-09-12 第二版番种表新增：路线牌型（数牌/刻子/幺九三条路线）
  // 门清：**仅标准四面子一将型生效**（特殊结构不计）
  | 'all-simples' | 'concealed-hand' | 'all-with-terminals'
  | 'one-suit-three-steps' | 'one-suit-four-steps' | 'pure-straight'
  | 'one-suit-three-joints' | 'one-suit-four-joints'

export type SpecialPatternId = 'pinghu' | 'sevenPairs' | 'luxury-seven-pairs' | 'shiSanLan' | 'qiXing' | 'thirteenOrphans'
export type PatternId = RegularPatternId | SpecialPatternId
export type HandShape = 'standard' | Exclude<SpecialPatternId, 'pinghu' | 'luxury-seven-pairs'>

export interface PatternDefinition {
  readonly id: PatternId
  readonly label: string
  readonly weight: number
  readonly excludes: readonly PatternId[]
}

/** Index is into input.concealed followed by the single winning tile. Never a wall index. */
export interface TileAssignment {
  readonly inputIndex: number
  readonly physical: TileType
  readonly represented: TileType
}

export interface DecomposedGroup {
  readonly kind: 'pair' | 'sequence' | 'triplet' | 'kong' | 'wind-kong'
  readonly tiles: readonly TileType[]
  readonly concealed: boolean
  readonly origin: { readonly kind: 'hand'; readonly inputIndexes: readonly number[] }
    | { readonly kind: 'meld'; readonly meldIndex: number }
}

/** Authority-only: never serialize this object into a public win event. */
export interface WinningDecomposition {
  readonly shape: HandShape
  readonly groups: readonly DecomposedGroup[]
  readonly assignments: readonly TileAssignment[]
  readonly winningTileGroupIndex: number | null
  readonly natural: boolean
}

export interface ScoringItem {
  readonly id: PatternId
  readonly label: string
  readonly weight: number
}

export interface ExcludedPattern {
  readonly id: PatternId
  readonly includedBy: PatternId
}
