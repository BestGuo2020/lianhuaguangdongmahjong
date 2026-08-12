import { describe, expect, it } from 'vitest'
import type { TileType } from '../../core/contracts/types'
import { takeStackTailTile } from './tileFlowExecutor'

describe('杠后尾墙补摸', () => {
  it('广麻连续补摸按尾墩上层、下层、前一墩上层、下层', () => {
    const wall = Array.from({ length: 136 }, (_, index) => `m${index}` as TileType)
    expect(takeStackTailTile(wall, 0, 136)).toBe('m134')
    expect(takeStackTailTile(wall, 0, 136)).toBe('m135')
    expect(takeStackTailTile(wall, 0, 136)).toBe('m132')
    expect(takeStackTailTile(wall, 0, 136)).toBe('m133')
  })

  it('牌头牌尾交汇时不保留牌，最后一张仍可补摸', () => {
    const wall = ['m1'] as TileType[]
    expect(takeStackTailTile(wall, 135, 136)).toBe('m1')
    expect(wall).toEqual([])
  })
})
