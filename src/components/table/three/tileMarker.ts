import type { TileType } from '../../../game/core/contracts/types'

export type TileMarker = 'joker' | 'wildcard' | false

/**
 * Resolve the displayed marker for a face-up tile.
 * White is a physical substitute tile, so it must always use the wildcard
 * marker even when older callers still include white in jokerTiles.
 */
export function tileMarkerFor(
  tile: TileType,
  jokerTiles: readonly TileType[] = [],
  wildcardTiles: readonly TileType[] = [],
): TileMarker {
  if (tile === 'white') {
    return wildcardTiles.includes(tile) || jokerTiles.includes(tile) ? 'wildcard' : false
  }
  if (jokerTiles.includes(tile)) return 'joker'
  if (wildcardTiles.includes(tile)) return 'wildcard'
  return false
}
