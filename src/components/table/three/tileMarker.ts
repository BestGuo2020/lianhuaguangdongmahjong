import type { TileType } from '../../../game/core/contracts/types'

export type TileMarker = 'joker' | 'wildcard' | 'laizi' | false

/**
 * Resolve the displayed marker for a face-up tile.
 * 白板语义区分：
 * - 莲花麻将（lotus-legacy）：白板是可替代精牌的实体牌 → 'wildcard'（替）
 * - 莲花广麻（lotus-classic）：白板本身是癞子（万能牌）→ 'laizi'（癞）
 * 判定依据是白板出现在哪个集合：wildcardTiles 含白板 → 替；仅 jokerTiles 含白板 → 癞。
 */
export function tileMarkerFor(
  tile: TileType,
  jokerTiles: readonly TileType[] = [],
  wildcardTiles: readonly TileType[] = [],
): TileMarker {
  if (tile === 'white') {
    if (wildcardTiles.includes(tile)) return 'wildcard'
    if (jokerTiles.includes(tile)) return 'laizi'
    return false
  }
  if (jokerTiles.includes(tile)) return 'joker'
  if (wildcardTiles.includes(tile)) return 'wildcard'
  return false
}
