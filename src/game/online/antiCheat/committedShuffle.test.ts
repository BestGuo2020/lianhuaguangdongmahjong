import { describe, expect, it } from 'vitest'
import { combineSeeds, deriveDice, hashSeed, shuffleTiles } from './committedShuffle'

describe('committedShuffle 纯函数', () => {
  it('shuffleTiles 同种子确定性、不同种子不同结果', () => {
    const tiles = ['a', 'b', 'c', 'd', 'e']
    expect(shuffleTiles(tiles, 'seed1')).toEqual(shuffleTiles(tiles, 'seed1'))
    expect(shuffleTiles(tiles, 'seed1')).not.toEqual(shuffleTiles(tiles, 'seed2'))
  })

  it('shuffleTiles 不丢失元素', () => {
    const tiles = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const shuffled = shuffleTiles(tiles, 'seed')
    expect([...shuffled].sort()).toEqual([...tiles].sort())
  })

  it('combineSeeds 与顺序无关', () => {
    expect(combineSeeds(['a', 'b', 'c'])).toBe(combineSeeds(['c', 'a', 'b']))
  })

  it('deriveDice 返回 1-6', () => {
    for (const seed of ['s1', 's2', 's3', 's4']) {
      const [a, b] = deriveDice(seed)
      expect(a).toBeGreaterThanOrEqual(1)
      expect(a).toBeLessThanOrEqual(6)
      expect(b).toBeGreaterThanOrEqual(1)
      expect(b).toBeLessThanOrEqual(6)
    }
  })

  it('hashSeed 对相同输入一致', async () => {
    expect(await hashSeed('0:abc')).toBe(await hashSeed('0:abc'))
  })
})
