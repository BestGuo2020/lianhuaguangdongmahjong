import { describe, expect, it } from 'vitest'
import {
  buildDrawOrderWall,
  removeFlipStack,
  resolveFlip,
  resolveOpeningStack,
  wallBreakIndexForOpeningStack,
} from './lotusWall'
import { WALL_TOTAL } from '../../core/rules/wallLayout'

/**
 * 复刻 tableTilePresenter.wallPhysicalIndex 语义：
 * 从 head（断点）沿环推进 index 步，跳过翻精墩 2 个物理张位。
 */
function physicalOf(index: number, head: number, flip: number | null): number {
  if (flip == null) return (head + index) % WALL_TOTAL
  const skipA = flip * 2
  let physical = head
  while (physical === skipA || physical === skipA + 1) physical = (physical + 1) % WALL_TOTAL
  for (let step = 0; step < index; step += 1) {
    do { physical = (physical + 1) % WALL_TOTAL } while (physical === skipA || physical === skipA + 1)
  }
  return physical
}

/**
 * 模拟渲染层当前实现（含 localSeat 旋转）：
 * resolveBreakIndex() = (wallBreakIndex + localSeat*34) % 136
 * resolveFlipStack()  = (flipStack + localSeat*17) % 68
 * addWall: wall[i] → physicalOf(headOffset + i, resolveBreakIndex())
 */
function renderWallPositions(
  ring: string[],
  localSeat: number,
  flipStack: number | null,
  wallBreakIndex: number,
  wall: string[],
): Map<string, number> {
  const L = localSeat * 34
  const flipRendered = flipStack == null ? null : (flipStack + localSeat * 17) % 68
  const head = (wallBreakIndex + L) % WALL_TOTAL
  const pos = new Map<string, number>()
  wall.forEach((tile, index) => {
    pos.set(tile, physicalOf(index, head, flipRendered))
  })
  return pos
}

describe('莲花麻将：翻精/开门前后牌山不得瞬移（按牌对比，各视角）', () => {
  it('所有座位视角下，立牌山→翻精→开门 三个阶段每张牌渲染位置一致', () => {
    for (let trial = 0; trial < 200; trial += 1) {
      const ring = Array.from({ length: 136 }, (_, i) => `t${i}`)
      const dealer = 0
      const d1 = 1 + Math.floor(Math.random() * 6)
      const d2 = 1 + Math.floor(Math.random() * 6)
      const t1 = 1 + Math.floor(Math.random() * 6)
      const t2 = 1 + Math.floor(Math.random() * 6)
      const { flipStack } = resolveFlip(ring as never[], dealer, [d1, d2] as [number, number])
      const openingStack = resolveOpeningStack(flipStack, [t1, t2] as [number, number])
      const breakIndex = wallBreakIndexForOpeningStack(openingStack, flipStack)

      const wallStart = [...ring]                       // 立牌山 136 张，wallBreakIndex=0, flipStack=null
      const wallFlip = removeFlipStack(ring as never[], flipStack)   // 翻精后 134 张, wallBreakIndex=0
      const wallOpen = buildDrawOrderWall(ring as never[], openingStack, flipStack) // 开门后 134 张, breakIndex

      for (let localSeat = 0; localSeat < 4; localSeat += 1) {
        const pStart = renderWallPositions(ring, localSeat, null, 0, wallStart)
        const pFlip = renderWallPositions(ring, localSeat, flipStack, 0, wallFlip)
        const pOpen = renderWallPositions(ring, localSeat, flipStack, breakIndex, wallOpen)

        for (const tile of ring) {
          if (tile === `t${flipStack * 2}` || tile === `t${flipStack * 2 + 1}`) continue // 翻精墩两张已移出
          const a = pStart.get(tile)
          const b = pFlip.get(tile)
          const c = pOpen.get(tile)
          if (a !== b || b !== c) {
            throw new Error(
              `瞬移! trial=${trial} localSeat=${localSeat} dice=[${d1},${d2}]/[${t1},${t2}]`
              + ` flipStack=${flipStack} openingStack=${openingStack} breakIndex=${breakIndex}`
              + ` 牌${tile}: 立牌山=${a} 翻精后=${b} 开门后=${c}`,
            )
          }
        }
      }
    }
  })
})
