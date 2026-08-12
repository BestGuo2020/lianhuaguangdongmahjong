import type { TileType } from '../../core/contracts/types'

export function countTiles(tiles: TileType[]): Map<TileType, number> {
  const counts = new Map<TileType, number>()
  tiles.forEach((tile) => counts.set(tile, (counts.get(tile) || 0) + 1))
  return counts
}

export function consumeTile(
  counts: Map<TileType, number>,
  tile: TileType,
  amount: number,
): Map<TileType, number> {
  const next = new Map(counts)
  const left = (next.get(tile) || 0) - amount
  if (left > 0) next.set(tile, left)
  else next.delete(tile)
  return next
}

export function firstRemainingTile(
  counts: Map<TileType, number>,
  order: TileType[],
): TileType | null {
  return order.find((tile) => (counts.get(tile) || 0) > 0) ?? null
}

export function matchingCount(tiles: TileType[], tile: TileType) {
  return tiles.filter((item) => item === tile).length
}
