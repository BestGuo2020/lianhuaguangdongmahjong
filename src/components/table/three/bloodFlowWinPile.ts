import { seatTableLayout, TABLE_LAYOUT, pilePitch, pileColumnsPerLevel } from '../../../game/core/presentation/tableLayout'
import type { WinBatch, WinRecord } from '../../../game/variants/lotus/bloodFlow/types'
import type { TileType } from '../../../game/core/contracts/types'
import { winDisplayLayout } from '../../../game/core/presentation/winEffect'

/** Use the existing single-win bay for each viewer-relative seat. */
export function bloodFlowPileAnchor(relativeSeat: number, compact = false) {
  const origin = winDisplayLayout(relativeSeat)
  const layout = seatTableLayout(relativeSeat)
  const along = [layout.pileAlong.x, layout.pileAlong.z]
  const outward = [layout.outward.x, layout.outward.z]
  // The compact Hu preview occupies the lower centre: put these two labels outside it.
  const badgeDistance = compact && (relativeSeat === 0 || relativeSeat === 3) ? 1.15 : relativeSeat === 0 ? -1.85 : -1.15
  return { origin, along,
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
    const perLevel = pileColumnsPerLevel(relativeSeat, compact)
    const pitch = pilePitch(relativeSeat)
    const tiles: WinPileTile[] = records.map((item, index) => {
      const column = index % perLevel, level = Math.floor(index / perLevel)
      return { ...item, column, level, x: origin.x + along[0] * column * pitch,
        y: origin.y + level * TABLE_LAYOUT.layerHeight, z: origin.z + along[1] * column * pitch, rotation: origin.rotation }
    })
    return { relativeSeat, absoluteSeat: (relativeSeat + localSeat) % 4, count: records.length,
      levels: Math.ceil(records.length / perLevel), overflow: 0, tiles }
  })
}
