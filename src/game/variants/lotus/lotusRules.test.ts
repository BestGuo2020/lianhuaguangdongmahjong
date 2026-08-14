import { describe, expect, it } from 'vitest'
import type { TileType } from '../../core/contracts/types'
import { sortTilesWithJokers } from '../../core/rules/tiles'
import {
  canChi,
  canPeng,
  canRobKong,
  computeJokers,
  concealedKongs,
  evaluateBasePattern,
  isQiXingShiSanLan,
  isSevenPairs,
  isShiSanLan,
  isThirteenOrphans,
  isWinningHand,
  nextInSequence,
  scoreFan,
  waitingTiles,
  windKong,
  winPayments,
} from './lotusRules'

// 通用癞子（避免出现在绝大多数构造手牌中）
const JOKERS: TileType[] = ['white', 'red']
const OTHER: TileType[] = ['north', 'west']

describe('癞子计算', () => {
  it('精牌在手牌排序中固定排在最左侧', () => {
    expect(sortTilesWithJokers(['m3', 'white', 'm1', 'red', 'p2'], ['white', 'red']))
      .toEqual(['red', 'white', 'm1', 'm3', 'p2'])
  })
  it('数牌 9 循环回 1', () => {
    expect(nextInSequence('m9')).toBe('m1')
    expect(nextInSequence('p3')).toBe('p4')
  })
  it('风牌循环：北 → 东', () => {
    expect(nextInSequence('north')).toBe('east')
  })
  it('箭牌循环：白 → 中', () => {
    expect(nextInSequence('white')).toBe('red')
  })
  it('翻精 = 指示牌 + 同序下一张', () => {
    expect(computeJokers('m5')).toEqual(['m5', 'm6'])
    expect(computeJokers('white')).toEqual(['red'])
    expect(sortTilesWithJokers(['white', 'm1', 'm5', 'm6'], computeJokers('m5')))
      .toEqual(['m5', 'm6', 'm1', 'white'])
  })
})

describe('平胡面子分解', () => {
  it('白板只能替代精牌或白板本身，不能替代普通牌', () => {
    const ordinaryGap: TileType[] = ['m1', 'm2', 'white', 'm4', 'm5', 'm6', 'p3', 'p4', 'p5', 's7', 's7', 's7', 'east', 'east']
    const jokerGap: TileType[] = ['m1', 'm2', 'white', 'm4', 'm5', 'm6', 'p3', 'p4', 's7', 's7', 's7', 'east', 'east', 'p1']
    expect(isWinningHand(ordinaryGap, 0, ['p1', 'p2'], [], ['white'])).toBe(false)
    expect(isWinningHand(jokerGap, 0, ['p1', 'p2'], [], ['white'])).toBe(true)
  })
  it('标准 4 面子 + 对子（无癞子）', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east', 'east']
    expect(isWinningHand(hand, 0, JOKERS)).toBe(true)
  })
  it('癞子补顺子缺张', () => {
    const hand: TileType[] = ['m1', 'm2', 'north', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 's9', 's9']
    expect(isWinningHand(hand, 0, ['north', 'white'])).toBe(true)
  })
  it('癞子补刻子缺张', () => {
    const hand: TileType[] = ['east', 'east', 'north', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 's9', 's9']
    expect(isWinningHand(hand, 0, ['north', 'white'])).toBe(true)
  })
  it('两张癞子做将牌', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'north', 'white']
    expect(isWinningHand(hand, 0, ['north', 'white'])).toBe(true)
  })
  it('单张 + 1 癞子做将牌', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east', 'north']
    expect(isWinningHand(hand, 0, ['north', 'white'])).toBe(true)
  })
  it('乱风顺：东南西任意三种不同风', () => {
    const hand: TileType[] = ['east', 'south', 'west', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'north', 'north']
    expect(isWinningHand(hand, 0, JOKERS)).toBe(true)
  })
  it('乱风顺：东 + 2 癞子补另两风', () => {
    const hand: TileType[] = ['east', 'north', 'white', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 's9', 's9']
    expect(isWinningHand(hand, 0, ['north', 'white'])).toBe(true)
  })
  it('东刻子与乱风顺共存（同一张不被重复计入）', () => {
    const hand: TileType[] = ['east', 'east', 'east', 'south', 'west', 'north', 'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's9', 's9']
    expect(isWinningHand(hand, 0, JOKERS)).toBe(true)
  })
  it('风牌不足以成刻子或乱风顺时不误判为胡', () => {
    // 东南西北各 1：最多组一组乱风顺，剩余单风与 s1,s5 无法再成面子/对子
    const hand: TileType[] = ['east', 'south', 'west', 'north', 'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's5', 's9', 's9']
    expect(isWinningHand(hand, 0, JOKERS)).toBe(false)
  })
  it('三元顺：中发白一组面子', () => {
    const hand: TileType[] = ['red', 'green', 'white', 'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's7', 's7', 's7', 's9', 's9']
    expect(isWinningHand(hand, 0, OTHER)).toBe(true)
  })
  it('三元顺：发白 + 1 癞子补中（锚定非红字牌）', () => {
    const hand: TileType[] = ['green', 'white', 'north', 'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's7', 's7', 's7', 's9', 's9']
    expect(isWinningHand(hand, 0, ['north', 'red'])).toBe(true)
  })
  it('有副露时按 11 张判定', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 's7', 's7', 's7', 'east', 'east']
    expect(isWinningHand(hand, 1, JOKERS)).toBe(true)
  })
  it('副露数与实际张数不符则不胡', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 's7', 's7', 's7', 'east', 'east', 'north', 'south']
    expect(isWinningHand(hand, 1, JOKERS)).toBe(false)
  })
})

describe('七对子', () => {
  it('7 个自然对', () => {
    const hand: TileType[] = ['m1', 'm1', 'm2', 'm2', 'm3', 'm3', 'p1', 'p1', 'p2', 'p2', 's7', 's7', 'east', 'east']
    expect(isSevenPairs(hand, JOKERS)).toBe(true)
  })
  it('6 对 + 2 癞子成对', () => {
    const hand: TileType[] = ['m1', 'm1', 'm2', 'm2', 'm3', 'm3', 'p1', 'p1', 'p2', 'p2', 's7', 's7', 'north', 'white']
    expect(isSevenPairs(hand, ['north', 'white'])).toBe(true)
  })
  it('6 对 + 单张 + 1 癞子配对', () => {
    const hand: TileType[] = ['m1', 'm1', 'm2', 'm2', 'm3', 'm3', 'p1', 'p1', 'p2', 'p2', 's7', 's7', 'east', 'north']
    expect(isSevenPairs(hand, ['north', 'white'])).toBe(true)
  })
  it('刻子拆成对 + 单张，需癞子补', () => {
    const hand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 'p2', 'p2', 'p3', 'p3', 's7', 's7', 'north']
    expect(isSevenPairs(hand, ['north', 'white'])).toBe(true)
  })
  it('2 个单张无癞子则不成', () => {
    const hand: TileType[] = ['m1', 'm1', 'm2', 'm2', 'm3', 'm3', 'p1', 'p1', 'p2', 'p2', 's7', 's7', 'east', 'north']
    expect(isSevenPairs(hand, JOKERS)).toBe(false)
  })
  it('13 张不成七对', () => {
    const hand: TileType[] = ['m1', 'm1', 'm2', 'm2', 'm3', 'm3', 'p1', 'p1', 'p2', 'p2', 's7', 's7', 'east']
    expect(isSevenPairs(hand, JOKERS)).toBe(false)
  })
})

describe('十三烂 / 七星十三烂', () => {
  const validShiSanLan: TileType[] = ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's1', 's4', 's7', 'east', 'south', 'west', 'north', 'red']
  it('同花色相邻至少差 3', () => {
    expect(isShiSanLan(validShiSanLan)).toBe(true)
  })
  it('同花色出现差 1 则不成立', () => {
    const hand: TileType[] = ['m1', 'm2', 'm7', 'p2', 'p5', 'p8', 's1', 's4', 's7', 'east', 'south', 'west', 'north', 'red']
    expect(isShiSanLan(hand)).toBe(false)
  })
  it('精牌可以替代冲突牌面', () => {
    const hand: TileType[] = ['m1', 'm2', 'm7', 'p2', 'p5', 'p8', 's1', 's4', 's7', 'east', 'south', 'west', 'north', 'white']
    expect(isShiSanLan(hand, ['m2', 'white'])).toBe(true)
    expect(isShiSanLan(hand)).toBe(false)
  })
  it('重复牌不成立', () => {
    const hand: TileType[] = ['m1', 'm1', 'm7', 'p2', 'p5', 'p8', 's1', 's4', 's7', 'east', 'south', 'west', 'north', 'red']
    expect(isShiSanLan(hand)).toBe(false)
  })
  it('字牌 south 不误判为数牌（s1-s3 差 2 应判不成立）', () => {
    const hand: TileType[] = ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's1', 's3', 's6', 's9', 'east', 'south', 'red', 'green']
    expect(isShiSanLan(hand)).toBe(false)
  })
  it('七星十三烂：七字全有', () => {
    const hand: TileType[] = ['east', 'south', 'west', 'north', 'red', 'green', 'white', 'm1', 'm4', 'm7', 'p2', 'p5', 'p8', 's1']
    expect(isQiXingShiSanLan(hand)).toBe(true)
    expect(evaluateBasePattern(hand, 0, JOKERS)).toEqual({ pattern: 'qiXing', fan: 4 })
  })
  it('七星十三烂：精牌可替补冲突牌面', () => {
    const hand: TileType[] = ['east', 'south', 'west', 'north', 'red', 'green', 'white', 'm1', 'm2', 'm7', 'p2', 'p5', 'p8', 's1']
    const jokers: TileType[] = ['m2', 'm3']
    // m1-m2 差 1 冲突，但 m2 是精牌可替补 → 仍成立七星。
    expect(isQiXingShiSanLan(hand, jokers, [], ['white'])).toBe(true)
    expect(evaluateBasePattern(hand, 0, jokers, [], ['white'])).toEqual({ pattern: 'qiXing', fan: 4 })
  })
  it('七星十三烂：七字允许精牌替补（缺 white 由精牌替补）', () => {
    // 物理缺 white，但精牌 m2 可替补成 white → 仍成立七星。
    const hand: TileType[] = ['east', 'south', 'west', 'north', 'red', 'green', 'm1', 'm4', 'm7', 'p2', 'p5', 'p8', 's1', 'm2']
    const jokers: TileType[] = ['m2', 'm3']
    expect(isQiXingShiSanLan(hand, jokers, [], ['white'])).toBe(true)
    expect(evaluateBasePattern(hand, 0, jokers, [], ['white'])).toEqual({ pattern: 'qiXing', fan: 4 })
  })
  it('缺一字且无精可替补时仍算十三烂（2 番）', () => {
    // 物理缺 white；本局精牌为 red（红中在手上作精），替补只能补一个字，凑不齐七字。
    const hand: TileType[] = ['east', 'south', 'west', 'north', 'red', 'green', 'm1', 'm4', 'm7', 'p2', 'p5', 'p8', 's1', 's4']
    expect(isQiXingShiSanLan(hand)).toBe(false)
    expect(isShiSanLan(hand)).toBe(true)
    expect(evaluateBasePattern(hand, 0, JOKERS)).toEqual({ pattern: 'shiSanLan', fan: 2 })
  })
})

describe('十三幺', () => {
  const terminals: TileType[] = ['m1', 'm9', 'p1', 'p9', 's1', 's9', 'east', 'south', 'west', 'north', 'red', 'green', 'white']
  it('13 种幺九/字牌全有且其一成对', () => {
    expect(isThirteenOrphans([...terminals, 'm1'])).toBe(true)
    expect(evaluateBasePattern([...terminals, 'm1'], 0, JOKERS)).toEqual({ pattern: 'thirteenOrphans', fan: 8 })
  })
  it('十三幺：精牌可替补缺失的幺九牌', () => {
    // 缺 s9，由精牌 m2 替补成 s9；m3 替补成对子。
    const hand: TileType[] = [...terminals.filter((tile) => tile !== 's9'), 'm2', 'm3']
    const jokers: TileType[] = ['m2', 'm3']
    expect(isThirteenOrphans(hand, jokers, [], ['white'])).toBe(true)
    expect(evaluateBasePattern(hand, 0, jokers, [], ['white'])).toEqual({ pattern: 'thirteenOrphans', fan: 8 })
  })
  it('缺一种幺九且无精可替补不成立', () => {
    const hand: TileType[] = [...terminals.filter((tile) => tile !== 's9'), 'east', 'west']
    expect(isThirteenOrphans(hand)).toBe(false)
  })
  it('重复的非幺九牌不成立', () => {
    expect(isThirteenOrphans([...terminals, 'm2'])).toBe(false)
  })
})

describe('番数与收付', () => {
  const pingHu: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east', 'east']
  const sevenPairs: TileType[] = ['m1', 'm1', 'm2', 'm2', 'm3', 'm3', 'p1', 'p1', 'p2', 'p2', 's7', 's7', 'east', 'east']

  it('天胡：平收 8 番，不叠加庄/自摸', () => {
    const score = scoreFan(pingHu, 0, JOKERS, {
      dealer: true, selfDraw: true, robbedKong: false, kongBloom: false, tianhu: true, dihu: false,
    })!
    expect(score.fan).toBe(8)
    expect(score.patterns).toEqual([{ label: '天胡', multiplier: 8 }])
    expect(score.settlement.total).toBe(9600)
  })
  it('地胡：闲家收 8H', () => {
    const score = scoreFan(pingHu, 0, JOKERS, {
      dealer: false, selfDraw: false, robbedKong: false, kongBloom: false, tianhu: false, dihu: true,
    })!
    expect(score.fan).toBe(8)
    expect(score.settlement.total).toBe(6400)
  })
  it('收付表四行', () => {
    expect(winPayments(1, { winnerIsDealer: false, selfDrawStyle: false })).toEqual({ H: 100, dealerPays: 200, nonDealerPays: 100, total: 400 })
    expect(winPayments(1, { winnerIsDealer: true, selfDrawStyle: false })).toEqual({ H: 100, dealerPays: 0, nonDealerPays: 200, total: 400 })
    expect(winPayments(1, { winnerIsDealer: false, selfDrawStyle: true })).toEqual({ H: 100, dealerPays: 400, nonDealerPays: 200, total: 800 })
    expect(winPayments(1, { winnerIsDealer: true, selfDrawStyle: true })).toEqual({ H: 100, dealerPays: 0, nonDealerPays: 400, total: 1200 })
  })
  it('闲家点炮平胡：庄 2H + 闲 1H + 闲 1H', () => {
    const score = scoreFan(pingHu, 0, JOKERS, {
      dealer: false, selfDraw: false, robbedKong: false, kongBloom: false, tianhu: false, dihu: false,
    })!
    expect(score.fan).toBe(1)
    expect(score.settlement).toEqual({ H: 100, dealerPays: 200, nonDealerPays: 100, total: 400 })
  })
  it('庄家自摸七对子：×2(自摸)×2(庄) 且收 12H', () => {
    const score = scoreFan(sevenPairs, 0, JOKERS, {
      dealer: true, selfDraw: true, robbedKong: false, kongBloom: false, tianhu: false, dihu: false,
    })!
    expect(score.fan).toBe(8)
    expect(score.settlement.total).toBe(2400)
  })
  it('抢杠胡加计自摸：闲家平胡 → ×2(自摸)×2(抢杠)', () => {
    const score = scoreFan(pingHu, 0, JOKERS, {
      dealer: false, selfDraw: false, robbedKong: true, kongBloom: false, tianhu: false, dihu: false,
    })!
    expect(score.fan).toBe(4)
    expect(score.patterns.map((item) => item.label)).toEqual(['平胡', '自摸', '抢杠胡'])
  })
  it('杠上开花加计自摸', () => {
    const score = scoreFan(pingHu, 0, JOKERS, {
      dealer: false, selfDraw: false, robbedKong: false, kongBloom: true, tianhu: false, dihu: false,
    })!
    expect(score.fan).toBe(4)
    expect(score.patterns.map((item) => item.label)).toEqual(['平胡', '自摸', '杠上开花'])
  })
})

describe('吃 / 碰 / 杠合法性', () => {
  it('顺子吃：中张弃牌给出多个窗口', () => {
    const hand: TileType[] = ['m2', 'm3', 'm5', 'm6']
    const chi = canChi(hand, 'm4', JOKERS)
    expect(chi).toEqual([
      { kind: 'sequence', tiles: ['m2', 'm3', 'm4'] },
      { kind: 'sequence', tiles: ['m3', 'm4', 'm5'] },
      { kind: 'sequence', tiles: ['m4', 'm5', 'm6'] },
    ])
  })
  it('乱风吃：任意三种不同风', () => {
    const chi = canChi(['south', 'west', 'north'], 'east', JOKERS)
    expect(chi).toHaveLength(3)
    expect(chi[0]).toEqual({ kind: 'wind', tiles: ['east', 'south', 'west'] })
  })
  it('箭牌吃：中发白', () => {
    expect(canChi(['green', 'white'], 'red', OTHER)).toEqual([{ kind: 'dragon', tiles: ['red', 'green', 'white'] }])
  })
  it('精牌可以按普通牌面参与吃', () => {
    expect(canChi(['south', 'west'], 'north', ['north', 'white'])).toEqual([
      { kind: 'wind', tiles: ['north', 'south', 'west'] },
    ])
    expect(canChi(['south', 'north'], 'east', ['north', 'white'])).toEqual([
      { kind: 'wind', tiles: ['east', 'south', 'north'] },
    ])
  })
  it('碰：精牌也按普通牌面处理', () => {
    expect(canPeng(['east', 'east'], 'east', JOKERS)).toBe(true)
    expect(canPeng(['east'], 'east', JOKERS)).toBe(false)
    expect(canPeng(['north', 'north'], 'north', ['north', 'white'])).toBe(true)
  })
  it('暗杠允许精牌按普通牌面使用', () => {
    expect(concealedKongs(['white', 'white', 'white', 'white', 'm1'], ['north', 'white'])).toEqual(['white'])
    expect(concealedKongs(['m1', 'm1', 'm1', 'm1'], ['north', 'white'])).toEqual(['m1'])
  })
  it('风杠：精牌作为对应风牌使用', () => {
    expect(windKong(['east', 'south', 'west', 'north'], JOKERS)).toBe(true)
    expect(windKong(['east', 'south', 'west'], JOKERS)).toBe(false)
    expect(windKong(['east', 'south', 'west', 'north'], ['north', 'white'])).toBe(true)
  })
  it('抢杠判定复用胡牌逻辑', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east']
    expect(canRobKong(hand, 'east', 0, JOKERS)).toBe(true)
  })

  it('白板可替代精牌，但不进入精牌集合', () => {
    const hand: TileType[] = ['m1', 'm2', 'white', 'm5', 'm6', 'm7', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east', 'east']
    expect(isWinningHand(hand, 0, ['m3', 'm4'], [], ['white'])).toBe(true)
    expect(isWinningHand(hand, 0, ['m3', 'm4'])).toBe(false)
  })

  it('外部进来的精牌只能按普通牌参与胡牌', () => {
    const hand: TileType[] = [
      'm1', 'm2', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east', 'north',
    ]
    expect(isWinningHand([...hand, 'white'], 0, ['north', 'white'])).toBe(true)
    expect(isWinningHand([...hand, 'white'], 0, ['north', 'white'], ['white'])).toBe(false)
  })
})

describe('听牌', () => {
  it('截图手牌在白板受限替代下的听口', () => {
    const hand: TileType[] = ['m3', 'm4', 'm5', 's2', 's3', 's4', 'east', 'south', 'red', 'white', 's5']
    expect(waitingTiles(hand.filter((_, index) => index !== 3), 1, ['p1', 'p2'], ['white'])).toEqual([])
    expect(waitingTiles(hand.filter((_, index) => index !== 8), 1, ['p1', 'p2'], ['white'])).toEqual([])
    expect(waitingTiles(hand.filter((_, index) => index !== 10), 1, ['p1', 'p2'], ['white'])).toEqual([])
  })
  it('列出补入后能胡的牌（单骑听东，或补入癞子与东成对）', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east']
    expect(waitingTiles(hand, 0, JOKERS)).toEqual(['east', 'red', 'white'])
  })
  it('癞子面也可以是听口（补入增加癞子数）', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'north']
    expect(waitingTiles(hand, 0, ['north', 'white'])).toContain('north')
  })
})
