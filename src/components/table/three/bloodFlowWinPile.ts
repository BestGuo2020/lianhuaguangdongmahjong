import { seatTableLayout, TABLE_LAYOUT, pilePitch, pileColumnsPerLevel } from '../../../game/core/presentation/tableLayout'
import type { TileType } from '../../../game/core/contracts/types'
import type { Seat } from '../../../game/variants/lotus/bloodFlow/types'
import { winDisplayLayout } from '../../../game/core/presentation/winEffect'

/**
 * 牌堆只用到批次的这几个字段（源牌 + 每条胡牌记录）。
 * 收窄成结构子集是刻意的：**回放**手里没有引擎的完整 WinBatch（番型/赔付/流水都在当时的快照里），
 * 但它按"胡"的步骤就能还原"谁・哪张牌・第几楼"，于是用同一套摆放函数画牌堆。
 * 实时的真 WinBatch 是它的超集，因此两边共用一条渲染路径。
 */
export interface WinPileBatch {
  batchId?: string
  source: { id: string; tile: TileType; seat: Seat; kind: 'draw' | 'discard' | 'added-kong' }
  winners: readonly { id: string; winner: number; ordinal?: number }[]
}

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
  record: { id: string; winner: number; ordinal?: number }
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
export function bloodFlowWinPiles(batches: readonly WinPileBatch[], localSeat = 0, compact = false) {
  const grouped = Array.from({ length: 4 }, () => [] as { record: { id: string; winner: number; ordinal?: number }; tile: TileType; sourceEventId: string }[])
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
