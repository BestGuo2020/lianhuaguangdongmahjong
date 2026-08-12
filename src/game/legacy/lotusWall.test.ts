import { describe, expect, it } from 'vitest'
import { computeJokers } from './lotusRules'
import {
  buildDrawOrderWall,
  buildLotusWall,
  buildRingWall,
  removeFlipStack,
  resolveFlip,
  resolveOpeningStack,
  seatSegmentStart,
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
    // T=8 → 开门 stack (4+8)%68=12
    const result = buildLotusWall({ dealer: 0, dice: [2, 3], secondDice: [4, 4], random: () => 0 })
    expect(result.flipStack).toBe(4)
    expect(result.openingStack).toBe(12)
    expect(result.wallBreakIndex).toBe(24)
  })

  it('翻精方位可能落到上家', () => {
    // dealer=2, S=10 → (2+10-1)%4=3（上家），段起始 17，右数第 10 墩 → 17+9=26
    // T=7 → 开门 (26+7)%68=33
    const result = buildLotusWall({ dealer: 2, dice: [5, 5], secondDice: [1, 6], random: () => 0 })
    expect(result.flipStack).toBe(26)
    expect(result.openingStack).toBe(33)
  })

  it('指示牌 + 同序下一张 = 癞子', () => {
    const result = buildLotusWall({ dealer: 0, dice: [1, 1], secondDice: [1, 1], random: () => 0 })
    expect(result.jokers).toEqual(computeJokers(result.flipTile))
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
    expect(result.openingStack).toBe(54)
    // wall[0]/wall[1] 是开门墩（54）的顶层/底层
    expect(result.wallBreakIndex).toBe(108)
    expect(result.wall).toHaveLength(134)
  })
})
