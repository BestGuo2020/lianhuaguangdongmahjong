import { describe, expect, it } from 'vitest'
import { chooseDiscardIndex, decideClaim, decideRobKong, decideTurn, makeTurnView } from './ai'
import type { AITurnView } from './ai'
import type { GamePlayer, Meld, TileType } from './types'

function view(hand: TileType[], melds: Meld[] = [], exposedMelds = 0, kongBloom = false): AITurnView {
  return { hand, melds, exposedMelds, kongBloom }
}

describe('decideTurn 自摸胡', () => {
  it('牌型可胡时返回 win', () => {
    // 14 张：m1 刻 + m2m3m4 顺 + p4p5p6 顺 + s7 刻 + east 对
    const hand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east']
    expect(decideTurn(view(hand))).toEqual({ kind: 'win' })
  })

  it('白板（癞子）可当任意牌参与胡牌', () => {
    // 14 张：m1 刻 + m2m3white(白板代 m4) 顺 + p4p5p6 顺 + s7 刻 + east 对
    const hand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'white', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east']
    expect(decideTurn(view(hand))).toEqual({ kind: 'win' })
  })
})

describe('decideTurn 补杠', () => {
  it('已碰且有第四张在手时返回 added-kong', () => {
    const melds: Meld[] = [{ type: 'peng', tile: 'east', from: 1, tiles: ['east', 'east', 'east'] }]
    const hand: TileType[] = ['east', 'm1', 'm2']
    expect(decideTurn(view(hand, melds, 1))).toEqual({ kind: 'added-kong', meldIndex: 0 })
  })
})

describe('decideTurn 暗杠', () => {
  it('手牌有 4 张相同牌时返回 concealed-kong', () => {
    const hand: TileType[] = ['s7', 's7', 's7', 's7', 'm1', 'm2', 'm3', 'p4', 'p5', 'east', 'east']
    expect(decideTurn(view(hand))).toEqual({ kind: 'concealed-kong', tile: 's7' })
  })
})

describe('decideTurn 弃牌', () => {
  it('无胡/无杠时返回 discard 且索引在合法范围', () => {
    const hand: TileType[] = ['m1', 'p4', 'p5', 'p6', 'east', 's2', 's2', 's9', 's9', 'white', 'white']
    const decision = decideTurn(view(hand))
    expect(decision.kind).toBe('discard')
    if (decision.kind === 'discard') {
      expect(decision.handIndex).toBeGreaterThanOrEqual(0)
      expect(decision.handIndex).toBeLessThan(hand.length)
    }
  })
})

describe('chooseDiscardIndex 弃牌启发式', () => {
  it('优先打掉无对无靠的孤张', () => {
    // east 是唯一孤张，其余 m1m2m3 成顺、p5p5 成对
    const hand: TileType[] = ['m1', 'm2', 'm3', 'p5', 'p5', 'east']
    const index = chooseDiscardIndex(hand, () => 0)
    expect(hand[index]).toBe('east')
  })

  it('癞子白板保手，优先打其它孤张', () => {
    const hand: TileType[] = ['white', 's9', 's9', 'm7']
    const index = chooseDiscardIndex(hand, () => 0)
    expect(hand[index]).toBe('m7')
  })

  it('对子与靠张越多越靠后打', () => {
    // m1m2m3 成顺（靠张多）、p5p5 成对，孤张 north 先打
    const hand: TileType[] = ['m1', 'm2', 'm3', 'p5', 'p5', 'north']
    const index = chooseDiscardIndex(hand, () => 0)
    expect(hand[index]).toBe('north')
  })
})

describe('decideClaim 吃碰杠响应', () => {
  it('canGang 为真时选择 gang', () => {
    expect(decideClaim({ hand: ['east', 'east', 'east', 'm1'], canGang: true })).toBe('gang')
  })

  it('canGang 为假时选择 peng', () => {
    expect(decideClaim({ hand: ['east', 'east', 'm1'], canGang: false })).toBe('peng')
  })
})

describe('decideRobKong 抢杠', () => {
  it('当前 AI 能抢必抢', () => {
    expect(decideRobKong()).toBe('win')
  })
})

// 确保快照构造与游戏侧一致，避免后续修改把 AI 视图悄悄改掉。
describe('makeTurnView 快照构造', () => {
  it('只暴露手牌与副露，不含分数等无关字段', () => {
    const player: GamePlayer = {
      name: 'AI', avatar: '', score: 1000, seat: 1,
      hand: ['m1', 'm2'], discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
    }
    expect(makeTurnView(player, 0, true)).toEqual({
      hand: ['m1', 'm2'],
      melds: [],
      exposedMelds: 0,
      kongBloom: true,
    })
  })
})
