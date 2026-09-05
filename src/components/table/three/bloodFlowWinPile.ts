import type { WinBatch, WinRecord } from '../../../game/variants/lotus/bloodFlow/types'
import type { TileType } from '../../../game/core/contracts/types'
import { winDisplayLayout } from '../../../game/core/presentation/winEffect'

/** Use the existing single-win bay for each viewer-relative seat. */
export function bloodFlowPileAnchor(relativeSeat: number, compact = false) {
  const origin = winDisplayLayout(relativeSeat)
  const along = [[1, 0], [0, -1], [-1, 0], [0, 1]][relativeSeat]
  const outward = [[0, 1], [1, 0], [0, -1], [-1, 0]][relativeSeat]
  const middle = ((compact ? 3 : 4) - 1) * .73 / 2
  // The compact Hu preview occupies the lower centre: put these two labels outside it.
  const badgeDistance = compact && (relativeSeat === 0 || relativeSeat === 3) ? 1.15 : relativeSeat === 0 ? -1.85 : -1.15
  return { origin: { ...origin, x: origin.x - along[0] * middle, z: origin.z - along[1] * middle }, along,
    badge: { x: origin.x + outward[0] * badgeDistance, y: origin.y, z: origin.z + outward[1] * badgeDistance } }
}

export interface WinPileTile {
  record: WinRecord
  tile: TileType
  sourceEventId: string
  column: number
  level: number
  x: number
  y: number
  z: number
  rotation: number
}

/** Display references only. No tile accounting or game transitions may read these tiles. */
export function bloodFlowWinPiles(batches: readonly WinBatch[], localSeat = 0, compact = false) {
  const perLevel = compact ? 3 : 4, levels = compact ? 2 : 3
  const grouped = Array.from({ length: 4 }, () => [] as { record: WinRecord; tile: TileType; sourceEventId: string }[])
  const seen = new Set<string>()
  for (const batch of batches) for (const record of batch.winners) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    const relative = (record.winner - localSeat + 4) % 4
    grouped[relative].push({ record, tile: batch.source.tile, sourceEventId: batch.source.id })
  }
  return grouped.map((records, relativeSeat) => {
    const { origin, along } = bloodFlowPileAnchor(relativeSeat, compact)
    const visible = records.slice(-perLevel * levels)
    const tiles: WinPileTile[] = visible.map((item, index) => {
      const column = index % perLevel, level = Math.floor(index / perLevel)
      return { ...item, column, level, x: origin.x + along[0] * column * .73,
        y: origin.y + level * .46, z: origin.z + along[1] * column * .73, rotation: origin.rotation }
    })
    return { relativeSeat, absoluteSeat: (relativeSeat + localSeat) % 4, count: records.length,
      overflow: Math.max(0, records.length - tiles.length), tiles }
  })
}
