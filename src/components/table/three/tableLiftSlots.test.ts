import { describe, expect, it } from 'vitest'
import { wallStackSlot } from '../../../game/core/rules/wallLayout'
import {
  LIFT_SLOT_EXTRA_TILE_LENGTHS,
  LIFT_SLOT_WIDTH_SCALE,
  TABLE_TILE_LENGTH,
  TABLE_TILE_WIDTH,
  liftSlotContainsStack,
  tableLiftSlots,
} from './tableLiftSlots'

describe('国内麻将机升牌口布局', () => {
  it('槽口宽度严格等于 1.6 倍麻将宽度', () => {
    expect(LIFT_SLOT_WIDTH_SCALE).toBe(1.6)
    tableLiftSlots().forEach((slot) => {
      expect(slot.width).toBeCloseTo(TABLE_TILE_WIDTH * 1.6, 8)
    })
  })

  it('槽口长边比牌山总长多一个麻将长度、中心不移动，四角槽口互不重叠', () => {
    expect(LIFT_SLOT_EXTRA_TILE_LENGTHS).toBe(1)
    const slots = tableLiftSlots()
    slots.forEach((slot) => {
      const first = wallStackSlot(slot.stackIndices[0])
      const last = wallStackSlot(slot.stackIndices[slot.stackIndices.length - 1])
      const wallLength = slot.orientation === 'horizontal'
        ? Math.abs(first.x - last.x) + TABLE_TILE_WIDTH
        : Math.abs(first.z - last.z) + TABLE_TILE_WIDTH
      expect(slot.length).toBeCloseTo(wallLength + TABLE_TILE_LENGTH, 8)
      expect(slot.centerX).toBeCloseTo((first.x + last.x) / 2, 8)
      expect(slot.centerZ).toBeCloseTo((first.z + last.z) / 2, 8)
    })
    // 四角不重叠：满长槽由牌墙位置保证，相邻槽口矩形不相交（真实麻将机结构）。
    const half = (slot: (typeof slots)[number]) => ({
      x0: slot.centerX - (slot.orientation === 'horizontal' ? slot.length : slot.width) / 2,
      x1: slot.centerX + (slot.orientation === 'horizontal' ? slot.length : slot.width) / 2,
      z0: slot.centerZ - (slot.orientation === 'horizontal' ? slot.width : slot.length) / 2,
      z1: slot.centerZ + (slot.orientation === 'horizontal' ? slot.width : slot.length) / 2,
    })
    const overlaps = (a: ReturnType<typeof half>, b: ReturnType<typeof half>) =>
      a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0
    for (const pair of [['near', 'right'], ['near', 'left'], ['far', 'right'], ['far', 'left']] as const) {
      expect(overlaps(half(slots.find(s => s.side === pair[0])!), half(slots.find(s => s.side === pair[1])!)), `${pair[0]}∩${pair[1]}`).toBe(false)
    }
  })

  it('四边 68 墩牌山全部压在对应槽口范围内', () => {
    const slots = tableLiftSlots()
    expect(slots).toHaveLength(4)
    slots.forEach((slot) => {
      expect(slot.stackIndices).toHaveLength(17)
      slot.stackIndices.forEach((stackIndex) => {
        expect(liftSlotContainsStack(slot, stackIndex), `${slot.side} stack ${stackIndex}`).toBe(true)
      })
    })
  })
})
