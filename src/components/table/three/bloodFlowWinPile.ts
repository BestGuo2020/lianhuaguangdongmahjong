import type { WinBatch, WinRecord } from '../../../game/variants/lotus/bloodFlow/types'
import type { TileType } from '../../../game/core/contracts/types'

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
    const visible = records.slice(-perLevel * levels)
    const tiles: WinPileTile[] = visible.map((item, index) => {
      const column = index % perLevel, level = Math.floor(index / perLevel)
      const lateral = -5.9 + column * .73, distance = 5.25
      const [x, z] = [[lateral, distance], [distance, -lateral], [-lateral, -distance], [-distance, lateral]][relativeSeat]
      return { ...item, column, level, x, y: .28 + level * .46, z, rotation: relativeSeat * Math.PI / 2 }
    })
    return { relativeSeat, absoluteSeat: (relativeSeat + localSeat) % 4, count: records.length,
      overflow: Math.max(0, records.length - tiles.length), tiles }
  })
}
