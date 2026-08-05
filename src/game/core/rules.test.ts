import { describe, expect, it } from 'vitest'
import { applyKongScore, applyWinScore, canRobKong, concealedKongs, drawHorses, isWinningHand, meldSourceTileIndex, scoreHand, waitingTiles } from './rules'
import type { GamePlayer, Meld, TileType } from './types'

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
    const waiting: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east']
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
    const hand: TileType[] = ['m2', 'm2', 'm5', 'm6', 'm7', 'p1', 'p2', 'p3', 'p4', 'p5', 's2', 's3', 's4']
    expect(waitingTiles(hand)).toEqual(expect.arrayContaining(['p3', 'p6']))
  })

  it('癞子可补顺子前端，并列出截图手牌的全部听口', () => {
    const hand: TileType[] = ['m7', 'm7', 'p8', 'p9', 's3', 's3', 'north', 'north', 'white', 'white']
    expect(waitingTiles(hand, 1)).toEqual(expect.arrayContaining(['m7', 'p7', 's3', 'north', 'white']))
  })

  it('白板作为癞子不能开暗杠', () => {
    expect(concealedKongs(['white', 'white', 'white', 'white', 'm1'])).toEqual([])
    expect(concealedKongs(['m1', 'm1', 'm1', 'm1', 'white'])).toEqual(['m1'])
  })
})

describe('买马与计分', () => {
  it('159 与红中均算中马', () => {
    const wall: TileType[] = ['m1', 'p2', 's5', 'red', 'east', 'm9', 's3', 'white', 'p7']
    const { horses, hits } = drawHorses(wall)
    expect(horses).toHaveLength(8)
    expect(hits).toBe(4)
    expect(wall).toEqual(['p7'])
  })

  it('倍数累乘后，中马按张数乘底分加算', () => {
    const score = scoreHand({ dealer: true, noJoker: true, fourRed: true, horseHits: 2 })
    expect(score.multiplier).toBe(16)
    expect(score.totalMultiplier).toBe(18)
    expect(score.horsePoints).toBe(200)
    expect(score.points).toBe(1800)
  })

  it('杠上开花翻倍并写入计分明细', () => {
    const score = scoreHand({ kongBloom: true })

    expect(score.multiplier).toBe(2)
    expect(score.points).toBe(200)
    expect(score.details).toContainEqual({ label: '杠上开花', multiplier: 2 })
  })

  it('总分严格按底分乘已知倍数再加中马底分', () => {
    const score = scoreHand({ dealer: true, noJoker: true, horseHits: 3 })

    expect(score.multiplier).toBe(4)
    expect(score.totalMultiplier).toBe(7)
    expect(score.points).toBe(700)
  })
})

describe('开杠与抢杠计分', () => {
  const players = (): GamePlayer[] => Array.from({ length: 4 }, (_, seat) => ({
    name: `测试玩家${seat + 1}`,
    avatar: '',
    score: 1000,
    seat,
    hand: [],
    discards: [],
    melds: [],
    redCount: 0,
    drawnTileIndex: -1,
  }))

  it('暗杠由其余三家各支付底分两倍', () => {
    const gamePlayers = players()
    const deltas = applyKongScore(gamePlayers, 0, 'concealed')
    expect(gamePlayers.map((player) => player.score)).toEqual([1600, 800, 800, 800])
    expect(deltas).toEqual([
      { playerIndex: 0, amount: 600 },
      { playerIndex: 1, amount: -200 },
      { playerIndex: 2, amount: -200 },
      { playerIndex: 3, amount: -200 },
    ])
  })

  it('明杠只由被杠者支付底分', () => {
    const gamePlayers = players()
    const deltas = applyKongScore(gamePlayers, 0, 'discard', 2)
    expect(gamePlayers.map((player) => player.score)).toEqual([1100, 1000, 900, 1000])
    expect(deltas).toEqual([
      { playerIndex: 0, amount: 100 },
      { playerIndex: 2, amount: -100 },
    ])
  })

  it('补杠由其余三家各支付底分', () => {
    const gamePlayers = players()
    const deltas = applyKongScore(gamePlayers, 0, 'added')
    expect(gamePlayers.map((player) => player.score)).toEqual([1300, 900, 900, 900])
    expect(deltas).toEqual([
      { playerIndex: 0, amount: 300 },
      { playerIndex: 1, amount: -100 },
      { playerIndex: 2, amount: -100 },
      { playerIndex: 3, amount: -100 },
    ])
  })

  it('抢杠胡只由补杠者支付胡牌分', () => {
    const gamePlayers = players()
    expect(applyWinScore(gamePlayers, 1, 180, 3)).toBe(180)
    expect(gamePlayers.map((player) => player.score)).toEqual([1000, 1180, 1000, 820])
  })

  it('闲家胡牌时庄家支付双倍，其他闲家正常支付', () => {
    const gamePlayers = players()

    expect(applyWinScore(gamePlayers, 1, 100, null, 0)).toBe(400)
    expect(gamePlayers.map((player) => player.score)).toEqual([800, 1400, 900, 900])
  })

  it('庄家胡牌时每位闲家均支付已翻倍的胡牌分', () => {
    const gamePlayers = players()

    expect(applyWinScore(gamePlayers, 0, 200, null, 0)).toBe(600)
    expect(gamePlayers.map((player) => player.score)).toEqual([1600, 800, 800, 800])
  })
})

describe('副露来源指向', () => {
  const peng = (from: number): Meld => ({ type: 'peng', tile: 'p3', from, tiles: ['p3', 'p3', 'p3'] })

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
