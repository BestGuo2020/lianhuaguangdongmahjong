import { describe, expect, it } from 'vitest'
import { WALL_STACKS, WALL_TOTAL, wallBreakIndex, wallStackSlot, wallTilePlacement } from './wallLayout'

describe('wall break index', () => {
  it('determines the wall by dice sum: 5/9→庄, 2/6/10→下, 3/7/11→对, 4/8/12→上', () => {
    // 庄家墙=近段[0,33]，下家=右段[102,135]，对家=远段[68,101]，上家=左段[34,67]
    expect(wallBreakIndex([5, 4])).toBeGreaterThanOrEqual(0)   // sum 9 → 庄家段
    expect(wallBreakIndex([5, 4])).toBeLessThan(34)
    expect(wallBreakIndex([2, 4])).toBeGreaterThanOrEqual(102) // sum 6 → 下家段
    expect(wallBreakIndex([2, 4])).toBeLessThan(136)
    expect(wallBreakIndex([1, 6])).toBeGreaterThanOrEqual(68)  // sum 7 → 对家段
    expect(wallBreakIndex([1, 6])).toBeLessThan(102)
    expect(wallBreakIndex([4, 4])).toBeGreaterThanOrEqual(34)  // sum 8 → 上家段
    expect(wallBreakIndex([4, 4])).toBeLessThan(68)
  })

  it('starts at column n+1 where n = the smaller die', () => {
    // [3,5]: sum 8 → 上家(段起点34)，n=3 → 34 + 3×2 = 40
    expect(wallBreakIndex([3, 5])).toBe(40)
    // [1,1]: sum 2 → 下家(段起点102)，n=1 → 102 + 2 = 104
    expect(wallBreakIndex([1, 1])).toBe(104)
    // [6,6]: sum 12 → 上家(段起点34)，n=6 → 34 + 12 = 46
    expect(wallBreakIndex([6, 6])).toBe(46)
    // [5,4]: sum 9 → 庄家(段起点0)，n=4 → 0 + 8 = 8
    expect(wallBreakIndex([5, 4])).toBe(8)
  })

  it('defaults missing dice to 1 (like the prop default [1, 1])', () => {
    expect(wallBreakIndex([undefined, undefined])).toBe(104)
  })
})

describe('wall tile placement', () => {
  it('pairs adjacent tiles into the same 墩, drawing the top tile first', () => {
    expect(wallTilePlacement(0, 0)).toEqual({ stackIndex: 0, layer: 1 })  // 先抓顶牌
    expect(wallTilePlacement(1, 0)).toEqual({ stackIndex: 0, layer: 0 })  // 再抓底牌
    expect(wallTilePlacement(2, 0)).toEqual({ stackIndex: 1, layer: 1 })
    expect(wallTilePlacement(3, 0)).toEqual({ stackIndex: 1, layer: 0 })
  })

  it('advances the head clockwise as tiles are drawn (headOffset grows)', () => {
    // 先抓了顶牌（physical 0）后，堆 0 只剩底牌（physical 1）
    expect(wallTilePlacement(0, 1)).toEqual({ stackIndex: 0, layer: 0 })
    expect(wallTilePlacement(1, 1)).toEqual({ stackIndex: 1, layer: 1 })
    // 抽走两张后 head 移到下一墩，先抓其顶牌
    expect(wallTilePlacement(0, 2)).toEqual({ stackIndex: 1, layer: 1 })
  })

  it('wraps at 136', () => {
    expect(wallTilePlacement(0, 136)).toEqual(wallTilePlacement(0, 0))
    expect(wallTilePlacement(0, 135)).toEqual({ stackIndex: 67, layer: 0 })
  })

  it('has no fixed reserved tail; only the current tail stack is arranged for kong draws', () => {
    // 初始牌尾：pop() 先拿 index 135（顶），再拿 index 134（底）。
    expect(wallTilePlacement(135, 0, 136)).toEqual({ stackIndex: 67, layer: 1 })
    expect(wallTilePlacement(134, 0, 136)).toEqual({ stackIndex: 67, layer: 0 })
    // 补走一张后，同墩只剩底牌；补完一墩后，新的当前尾墩才翻成顶/底顺序。
    expect(wallTilePlacement(134, 0, 135)).toEqual({ stackIndex: 67, layer: 0 })
    expect(wallTilePlacement(133, 0, 134)).toEqual({ stackIndex: 66, layer: 1 })
    expect(wallTilePlacement(132, 0, 134)).toEqual({ stackIndex: 66, layer: 0 })
  })
})

describe('wall stack ring', () => {
  it('places stack 0 at the near (bottom) right end = draw head', () => {
    const s = wallStackSlot(0)
    expect(s.x).toBeGreaterThan(0)          // 右端
    expect(s.z).toBeCloseTo(4.73, 5)        // 近侧（已向牌河前移半个牌）
    expect(s.rotationY).toBeCloseTo(0, 5)   // 径向：长边沿 z（指向桌中心）
  })

  it('advances clockwise near → left → far → right', () => {
    const near = wallStackSlot(0)
    const left = wallStackSlot(17)
    const far = wallStackSlot(34)
    const right = wallStackSlot(51)
    expect(near.z).toBeCloseTo(4.73, 5)
    expect(Math.abs(left.x)).toBeCloseTo(7.43, 5)
    expect(far.z).toBeCloseTo(-8.03, 5)
    expect(Math.abs(right.x)).toBeCloseTo(7.43, 5)
    expect(left.x).toBeLessThan(0)
    expect(right.x).toBeGreaterThan(0)
    // 侧墙径向：长边沿 x（指向桌中心）
    expect(right.rotationY).toBeCloseTo(Math.PI / 2, 5)
  })

  it('spaces consecutive stacks one tile-width apart within a segment', () => {
    const near0 = wallStackSlot(0)
    const near1 = wallStackSlot(1)
    expect(Math.hypot(near0.x - near1.x, near0.z - near1.z)).toBeCloseTo(0.68, 5)
    const left0 = wallStackSlot(17)
    const left1 = wallStackSlot(18)
    expect(Math.hypot(left0.x - left1.x, left0.z - left1.z)).toBeCloseTo(0.68, 5)
  })

  it('keeps every stack inside the playing surface', () => {
    for (let s = 0; s < WALL_STACKS; s += 1) {
      const { x, z } = wallStackSlot(s)
      expect(Math.abs(x)).toBeLessThanOrEqual(10.5)
      expect(z).toBeGreaterThanOrEqual(-12.1)
      expect(z).toBeLessThanOrEqual(8.9)
    }
  })

  it('wraps modulo 68', () => {
    expect(wallStackSlot(WALL_STACKS)).toEqual(wallStackSlot(0))
    expect(wallStackSlot(-1)).toEqual(wallStackSlot(WALL_STACKS - 1))
  })
})
