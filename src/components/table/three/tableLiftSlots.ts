import { wallStackSlot } from '../../../game/core/rules/wallLayout'

export const TABLE_TILE_WIDTH = .68
export const TABLE_TILE_LENGTH = .94
export const LIFT_SLOT_WIDTH_SCALE = 1.6
export const LIFT_SLOT_EXTRA_TILE_LENGTHS = 1

export type LiftSlotSide = 'near' | 'far' | 'left' | 'right'

export interface TableLiftSlot {
  side: LiftSlotSide
  centerX: number
  centerZ: number
  length: number
  width: number
  orientation: 'horizontal' | 'vertical'
  stackIndices: readonly number[]
}

const indices = (start: number) => Array.from({ length: 17 }, (_, index) => start + index)

function horizontalSlot(side: 'near' | 'far', stackIndices: readonly number[]): TableLiftSlot {
  const first = wallStackSlot(stackIndices[0])
  const last = wallStackSlot(stackIndices[stackIndices.length - 1])
  return {
    side,
    centerX: (first.x + last.x) / 2,
    centerZ: (first.z + last.z) / 2,
    length: Math.abs(first.x - last.x) + TABLE_TILE_WIDTH
      + TABLE_TILE_LENGTH * LIFT_SLOT_EXTRA_TILE_LENGTHS,
    width: TABLE_TILE_WIDTH * LIFT_SLOT_WIDTH_SCALE,
    orientation: 'horizontal',
    stackIndices,
  }
}

function verticalSlot(side: 'left' | 'right', stackIndices: readonly number[]): TableLiftSlot {
  const first = wallStackSlot(stackIndices[0])
  const last = wallStackSlot(stackIndices[stackIndices.length - 1])
  return {
    side,
    centerX: (first.x + last.x) / 2,
    centerZ: (first.z + last.z) / 2,
    length: Math.abs(first.z - last.z) + TABLE_TILE_WIDTH
      + TABLE_TILE_LENGTH * LIFT_SLOT_EXTRA_TILE_LENGTHS,
    width: TABLE_TILE_WIDTH * LIFT_SLOT_WIDTH_SCALE,
    orientation: 'vertical',
    stackIndices,
  }
}

/** 四条升牌口完全由牌山权威坐标推导，保证牌山中心落在槽口内部。 */
export function tableLiftSlots(): readonly TableLiftSlot[] {
  return [
    horizontalSlot('near', indices(0)),
    verticalSlot('left', indices(17)),
    horizontalSlot('far', indices(34)),
    verticalSlot('right', indices(51)),
  ]
}

export function liftSlotContainsStack(slot: TableLiftSlot, stackIndex: number): boolean {
  const stack = wallStackSlot(stackIndex)
  const halfLength = slot.length / 2
  const halfWidth = slot.width / 2
  return slot.orientation === 'horizontal'
    ? Math.abs(stack.x - slot.centerX) <= halfLength && Math.abs(stack.z - slot.centerZ) <= halfWidth
    : Math.abs(stack.z - slot.centerZ) <= halfLength && Math.abs(stack.x - slot.centerX) <= halfWidth
}
