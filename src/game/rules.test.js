import { describe, expect, it } from 'vitest'
import { applyKongScore, applyWinScore, canRobKong, concealedKongs, drawHorses, isWinningHand, meldSourceTileIndex, scoreHand, waitingTiles } from './rules'

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

  it('一组副露且三张白板补齐牌型时可以胡牌', () => {
    expect(isWinningHand([
      'm4', 'm6', 'p3', 'p5', 'p8',
      's4', 's5', 's6',
      'white', 'white', 'white',
    ], 1)).toBe(true)
  })

  it('列出听牌时可胡的牌', () => {
    expect(waitingTiles([
      'm1', 'm2', 'm3',
      'm4', 'm5', 'm6',
      'p2', 'p3', 'p4',
      's7', 's7', 's7',
      'east',
    ])).toContain('east')
  })

  it('打出多余五筒后提示三筒和六筒', () => {
    const hand = ['m2', 'm2', 'm5', 'm6', 'm7', 'p1', 'p2', 'p3', 'p4', 'p5', 's2', 's3', 's4']
    expect(waitingTiles(hand)).toEqual(expect.arrayContaining(['p3', 'p6']))
  })

  it('癞子可补顺子前端，并列出截图手牌的全部听口', () => {
    const hand = ['m7', 'm7', 'p8', 'p9', 's3', 's3', 'north', 'north', 'white', 'white']
    expect(waitingTiles(hand, 1)).toEqual(expect.arrayContaining(['m7', 'p7', 's3', 'north', 'white']))
  })

  it('白板作为癞子不能开暗杠', () => {
    expect(concealedKongs(['white', 'white', 'white', 'white', 'm1'])).toEqual([])
    expect(concealedKongs(['m1', 'm1', 'm1', 'm1', 'white'])).toEqual(['m1'])
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

  it('倍数累乘后，中马按张数乘底分加算', () => {
    const score = scoreHand({ dealer: true, noJoker: true, fourRed: true, horseHits: 2 })
    expect(score.multiplier).toBe(16)
    expect(score.horsePoints).toBe(20)
    expect(score.points).toBe(180)
  })
})

describe('开杠与抢杠计分', () => {
  const scores = () => Array.from({ length: 4 }, () => ({ score: 1000 }))

  it('暗杠由其余三家各支付底分两倍', () => {
    const players = scores()
    applyKongScore(players, 0, 'concealed')
    expect(players.map((player) => player.score)).toEqual([1060, 980, 980, 980])
  })

  it('明杠只由被杠者支付底分', () => {
    const players = scores()
    applyKongScore(players, 0, 'discard', 2)
    expect(players.map((player) => player.score)).toEqual([1010, 1000, 990, 1000])
  })

  it('补杠由其余三家各支付底分', () => {
    const players = scores()
    applyKongScore(players, 0, 'added')
    expect(players.map((player) => player.score)).toEqual([1030, 990, 990, 990])
  })

  it('抢杠胡只由补杠者支付胡牌分', () => {
    const players = scores()
    expect(applyWinScore(players, 1, 180, 3)).toBe(180)
    expect(players.map((player) => player.score)).toEqual([1000, 1180, 1000, 820])
  })
})

describe('副露来源指向', () => {
  const peng = (from) => ({ type: 'peng', from, tiles: ['p3', 'p3', 'p3'] })

  it('四个座位均按右侧、对家、左侧来源映射到首张、中间和末张', () => {
    for (let playerIndex = 0; playerIndex < 4; playerIndex += 1) {
      expect(meldSourceTileIndex(peng((playerIndex + 1) % 4), playerIndex)).toBe(0)
      expect(meldSourceTileIndex(peng((playerIndex + 2) % 4), playerIndex)).toBe(1)
      expect(meldSourceTileIndex(peng((playerIndex + 3) % 4), playerIndex)).toBe(2)
    }
  })

  it('右侧玩家碰顶部玩家的牌时横置靠顶部的第一张', () => {
    expect(meldSourceTileIndex(peng(2), 1)).toBe(0)
  })
})
