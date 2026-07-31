import { describe, expect, it } from 'vitest'
import { canRobKong, drawHorses, isWinningHand, scoreHand } from './rules'

describe('莲花广麻胡牌规则', () => {
  it('识别标准自摸牌型', () => {
    expect(isWinningHand([
      'm1', 'm2', 'm3',
      'm4', 'm5', 'm6',
      'p2', 'p3', 'p4',
      's7', 's7', 's7',
      'east', 'east',
    ])).toBe(true)
  })

  it('白板可代替任意缺牌', () => {
    expect(isWinningHand([
      'm1', 'm2', 'white',
      'm4', 'm5', 'm6',
      'p2', 'p3', 'p4',
      's7', 's7', 's7',
      'east', 'white',
    ])).toBe(true)
  })

  it('普通弃牌不胡但补杠牌可触发抢杠胡判定', () => {
    const waiting = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east']
    expect(canRobKong(waiting, 'east')).toBe(true)
  })

  it('有一组副露时按十一张牌判断', () => {
    expect(isWinningHand(['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east'], 1)).toBe(true)
  })
})

describe('买马与计分', () => {
  it('159 与红中均算中马', () => {
    const wall = ['m1', 'p2', 's5', 'red', 'east', 'm9', 's3', 'white', 'p7']
    const { horses, hits } = drawHorses(wall)
    expect(horses).toHaveLength(8)
    expect(hits).toBe(4)
    expect(wall).toEqual(['p7'])
  })

  it('庄家、无癞子、四红中和买马番数累乘', () => {
    const score = scoreHand({ dealer: true, noJoker: true, fourRed: true, horseHits: 2 })
    expect(score.multiplier).toBe(64)
    expect(score.points).toBe(640)
  })
})
