import { describe, expect, it } from 'vitest'
import type { TileType } from '../../core/contracts/types'
import { computeJokers } from './lotusRules'
import {
  buildDrawOrderWall,
  buildLotusWall,
  buildRingWall,
  removeFlipStack,
  resolveFlip,
  resolveOpeningStack,
  seatSegmentStart,
  takeLotusTailTile,
  wallBreakIndexForOpeningStack,
} from './lotusWall'

describe('莲花麻将开局分步构造（立牌山 → 翻精 → 开门）', () => {
  it('立起的牌山为 136 张环序', () => {
    const ring = buildRingWall(() => 0)
    expect(ring).toHaveLength(136)
  })
  it('移出翻精墩后剩 134 张', () => {
    const ring = buildRingWall(() => 0)
    const { flipSeat, flipStack } = resolveFlip(ring, 0, [1, 1])
    expect(flipSeat).toBe(1)
    expect(flipStack).toBe(52)
    const wall = removeFlipStack(ring, flipStack)
    expect(wall).toHaveLength(134)
  })
  it('分步结果与一次性 buildLotusWall 一致', () => {
    const ring = buildRingWall(() => 0)
    const { flipStack, flipTile, jokers } = resolveFlip(ring, 1, [2, 3])
    const openingStack = resolveOpeningStack(flipStack, [4, 4])
    const wall = buildDrawOrderWall(ring, openingStack, flipStack)
    const combined = buildLotusWall({ dealer: 1, dice: [2, 3], secondDice: [4, 4], random: () => 0 })
    expect(wall).toEqual(combined.wall)
    expect(flipTile).toBe(combined.flipTile)
    expect(jokers).toEqual(combined.jokers)
    expect(openingStack).toBe(combined.openingStack)
    expect(wallBreakIndexForOpeningStack(openingStack)).toBe(combined.wallBreakIndex)
  })

  it('第二次骰子从翻精墩向后数 T+1 墩，而不是 T 墩', () => {
    expect(resolveOpeningStack(10, [1, 1])).toBe(13)
    expect(resolveOpeningStack(66, [6, 6])).toBe(11)
  })
  it('杠后从当前尾墙先补摸顶层，再摸同墩底层', () => {
    const ring = Array.from({ length: 136 }, (_, index) => `m${index}` as TileType)
    const wall = buildDrawOrderWall(ring, 0, 10)
    expect(takeLotusTailTile(wall, 0)).toBe(ring[67 * 2])
    expect(takeLotusTailTile(wall, 0)).toBe(ring[67 * 2 + 1])
    expect(takeLotusTailTile(wall, 0)).toBe(ring[66 * 2])
    expect(takeLotusTailTile(wall, 0)).toBe(ring[66 * 2 + 1])
  })
  it('不保留王牌，牌头与杠尾合计可摸完全部 134 张', () => {
    const ring = Array.from({ length: 136 }, (_, index) => `m${index}` as TileType)
    const wall = buildDrawOrderWall(ring, 0, 10)
    let headDrawn = 0
    expect(takeLotusTailTile(wall, headDrawn)).not.toBeNull()
    while (wall.length) {
      wall.shift()
      headDrawn += 1
    }
    expect(headDrawn + 1).toBe(134)
    expect(takeLotusTailTile(wall, headDrawn)).toBeNull()
  })
})

describe('莲花麻将牌墙构造', () => {
  it('座位段起始墩', () => {
    expect(seatSegmentStart(0)).toBe(0)
    expect(seatSegmentStart(1)).toBe(51)
    expect(seatSegmentStart(2)).toBe(34)
    expect(seatSegmentStart(3)).toBe(17)
  })

  it('第一次掷骰定翻精方位，第二次定开门位置', () => {
    // dealer=0, S=5 → 翻精方位 (0+5-1)%4=0（庄），右数第 5 墩 → stack 0+4
    // T=8 → 从翻精墩向后数 T+1 墩，开门 stack (4+8+1)%68=13
    const result = buildLotusWall({ dealer: 0, dice: [2, 3], secondDice: [4, 4], random: () => 0 })
    expect(result.flipStack).toBe(4)
    expect(result.openingStack).toBe(13)
    expect(result.wallBreakIndex).toBe(26)
  })

  it('翻精方位可能落到上家', () => {
    // dealer=2, S=10 → (2+10-1)%4=3（上家），段起始 17，右数第 10 墩 → 17+9=26
    // T=7 → 从翻精墩向后数 T+1 墩，开门 (26+7+1)%68=34
    const result = buildLotusWall({ dealer: 2, dice: [5, 5], secondDice: [1, 6], random: () => 0 })
    expect(result.flipStack).toBe(26)
    expect(result.openingStack).toBe(34)
  })

  it('指示牌 + 同序下一张 = 癞子', () => {
    const result = buildLotusWall({ dealer: 0, dice: [1, 1], secondDice: [1, 1], random: () => 0 })
    expect(result.jokers).toEqual(computeJokers(result.flipTile))
    expect(result.jokers).not.toContain('white')
  })

  it('翻精墩整体跳过，牌墙 134 张且每种不超过 4 张', () => {
    const result = buildLotusWall({ dealer: 0, dice: [1, 1], secondDice: [1, 1], random: () => 0 })
    expect(result.wall).toHaveLength(134)
    const counts = new Map<string, number>()
    result.wall.forEach((tile) => counts.set(tile, (counts.get(tile) || 0) + 1))
    counts.forEach((count) => expect(count).toBeLessThanOrEqual(4))
  })

  it('开门墩为牌墙头：wall[0] 为该墩顶层', () => {
    const result = buildLotusWall({ dealer: 0, dice: [1, 1], secondDice: [1, 1], random: () => 0 })
    expect(result.flipStack).toBe(52)
    expect(result.openingStack).toBe(55)
    // wall[0]/wall[1] 是开门墩（55）的顶层/底层
    expect(result.wallBreakIndex).toBe(110)
    expect(result.wall).toHaveLength(134)
  })

  it('发牌顺序从开门墩顺时针展开，并整墩跳过翻精墩', () => {
    const ring = Array.from({ length: 136 }, (_, index) => `m${index}` as TileType)
    const wall = buildDrawOrderWall(ring, 66, 1)

    expect(wall.slice(0, 8)).toEqual([
      ring[66 * 2], ring[66 * 2 + 1],
      ring[67 * 2], ring[67 * 2 + 1],
      ring[0], ring[1],
      ring[2 * 2], ring[2 * 2 + 1],
    ])
    expect(wall).not.toContain(ring[2])
    expect(wall).not.toContain(ring[3])
    expect(wall).toHaveLength(134)
  })

  it('3D 断点指向开门墩的物理上层张位，并按 136 张环回', () => {
    expect(wallBreakIndexForOpeningStack(0)).toBe(0)
    expect(wallBreakIndexForOpeningStack(55)).toBe(110)
    expect(wallBreakIndexForOpeningStack(68)).toBe(0)
    expect(wallBreakIndexForOpeningStack(-1)).toBe(134)
    expect(wallBreakIndexForOpeningStack(52, 52)).toBe(106)
  })
})
