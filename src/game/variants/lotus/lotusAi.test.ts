import { describe, expect, it } from 'vitest'
import type { TileType } from '../../core/contracts/types'
import { chooseDiscardIndex, decideClaim, decideRobKong, decideTurn } from './lotusAi'
import type { LotusClaimView, LotusTurnView } from './lotusAi'
import { waitingTiles, type ChiMeld } from './lotusRules'

const JOKERS: TileType[] = ['white', 'red']

function turnView(hand: TileType[], melds = [], exposedMelds = 0, kongBloom = false, jokers = JOKERS): LotusTurnView {
  return { hand, melds, exposedMelds, kongBloom, jokers }
}

describe('莲花麻将 AI 回合决策', () => {
  it('能胡自摸则胡', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east', 'east']
    expect(decideTurn(turnView(hand))).toEqual({ kind: 'win' })
  })
  it('补杠优先于暗杠与弃牌', () => {
    const hand: TileType[] = ['east', 'east', 'north']
    const melds = [{ type: 'peng', tile: 'east', tiles: ['east', 'east', 'east'] }]
    const decision = decideTurn(turnView(hand, melds))
    expect(decision.kind).toBe('added-kong')
  })
  it('暗杠（包含精牌）优先于弃牌', () => {
    const hand: TileType[] = ['m1', 'm1', 'm1', 'm1', 'm2', 'm3']
    const decision = decideTurn(turnView(hand))
    expect(decision).toEqual({ kind: 'concealed-kong', tile: 'm1' })
  })
  it('乱风杠优先于弃牌', () => {
    const hand: TileType[] = ['east', 'south', 'west', 'north', 'm2', 'm3']
    const decision = decideTurn(turnView(hand))
    expect(decision).toEqual({ kind: 'wind-kong' })
  })
  it('精牌可以按普通牌面暗杠', () => {
    const hand: TileType[] = ['white', 'white', 'white', 'white', 'm2', 'm3']
    const decision = decideTurn(turnView(hand, [], 0, false, ['north', 'white']))
    expect(decision).toEqual({ kind: 'concealed-kong', tile: 'white' })
  })

  it('公开牌河中已经出现较多的牌优先作为安全弃牌', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'south', 'west', 'north', 'red']
    const index = chooseDiscardIndex(hand, ['white', 'red'], () => 0, {
      exposedMelds: 0,
      visibleTiles: [...hand, 'east'],
      publicTiles: ['east', 'east', 'east'],
    })
    expect(hand[index]).toBe('east')
  })

  it('上家刚打出的牌获得跟牌偏好', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'south', 'west', 'north', 'red']
    const index = chooseDiscardIndex(hand, ['white', 'red'], () => 0, {
      exposedMelds: 0,
      visibleTiles: [...hand, 'east'],
      publicTiles: ['east'],
      upperLastDiscard: 'east',
    })
    expect(hand[index]).toBe('east')
  })

  it('四牌出现在牌河时，一七牌获得一四七软安全提示', () => {
    const hand: TileType[] = ['m1', 'p9', 'white', 'red', 'white', 'red', 'white', 'red', 'white', 'red', 'white', 'red', 'white', 'red']
    const index = chooseDiscardIndex(hand, ['white', 'red'], () => 0, {
      exposedMelds: 0,
      visibleTiles: [...hand, 'm1'],
      publicTiles: ['m4', 'm4', 'p9'],
    })
    expect(hand[index]).toBe('m1')
  })
})

describe('莲花麻将 AI 吃碰杠决策', () => {
  const claimView = (overrides: Partial<LotusClaimView> = {}): LotusClaimView => ({
    hand: [], exposedMelds: 0, canPeng: false, tile: 'm4', from: 1, canGang: false, chiOptions: [], jokers: JOKERS, ...overrides,
  })
  it('能杠必杠', () => {
    expect(decideClaim(claimView({ canGang: true }))).toEqual({ kind: 'gang' })
  })
  it('碰后没有提升听牌时选择过', () => {
    const decision = decideClaim(claimView({
      hand: ['m4', 'm4', 'm1', 'm2', 'm3', 'm7', 'm8', 'm9', 'p1', 'p2', 'p3', 'p5', 'p6'],
      canPeng: true,
    }))
    expect(decision).toEqual({ kind: 'pass' })
  })
  it('碰后能提升听牌时才碰并给出后续弃牌索引', () => {
    const decision = decideClaim(claimView({
      hand: ['m4', 'm4', 'm1', 'm2', 'm3', 'm7', 'm8', 'm9', 'p1', 'p2', 'p3', 'p5', 's5'],
      canPeng: true,
    }))
    expect(decision.kind).toBe('peng')
    if (decision.kind === 'peng') expect(decision.discardIndex).toBeGreaterThanOrEqual(0)
  })
  it('能吃则吃', () => {
    const chiOptions: ChiMeld[] = [{ kind: 'sequence', tiles: ['m2', 'm3', 'm4'] }]
    const decision = decideClaim(claimView({
      hand: ['m2', 'm3', 'm5', 'm6', 'm7', 'p1', 'p2', 'p3', 'p5', 'p6', 'p7', 's1', 's2'],
      chiOptions,
    }))
    expect(decision).toEqual({ kind: 'chi', meld: chiOptions[0] })
  })
  it('吃完不听牌时选择过', () => {
    const chiOptions: ChiMeld[] = [{ kind: 'sequence', tiles: ['m2', 'm3', 'm4'] }]
    expect(decideClaim(claimView({
      hand: ['m2', 'm3', 'p1', 'p5', 's2'],
      chiOptions,
    }))).toEqual({ kind: 'pass' })
  })
  it('多种吃法选择吃后听牌最多的组合', () => {
    const chiOptions: ChiMeld[] = [
      { kind: 'sequence', tiles: ['m2', 'm3', 'm4'] },
      { kind: 'sequence', tiles: ['m3', 'm4', 'm5'] },
    ]
    const hand: TileType[] = ['m2', 'm3', 'm5', 'p1', 'p2', 'p3', 'p5', 'p6', 'p7', 's1', 's2', 's3', 's5']
    const waitsAfterChi = (meld: ChiMeld) => {
      const remaining = [...hand]
      meld.tiles.forEach((meldTile) => {
        if (meldTile === 'm4') return
        remaining.splice(remaining.indexOf(meldTile), 1)
      })
      return Math.max(...remaining.map((_, index) => waitingTiles(
        remaining.filter((__, candidateIndex) => candidateIndex !== index),
        1,
        JOKERS,
      ).length))
    }
    const expected = waitsAfterChi(chiOptions[1]) > waitsAfterChi(chiOptions[0]) ? chiOptions[1] : chiOptions[0]
    const decision = decideClaim(claimView({ hand, chiOptions }))
    expect(decision.kind).toBe('chi')
    if (decision.kind === 'chi') expect(decision.meld).toEqual(expected)
  })
  it('没有任何可改善听牌的动作时过', () => {
    expect(decideClaim(claimView())).toEqual({ kind: 'pass' })
  })
})

describe('抢杠', () => {
  it('能抢必抢', () => {
    expect(decideRobKong({ hand: [], exposedMelds: 0, tile: 'east', from: 0, jokers: JOKERS })).toBe('win')
  })
})

describe('弃牌启发式', () => {
  it('优先保留精，打出孤张', () => {
    const hand: TileType[] = ['m1', 'm2', 'north', 'white']
    const index = chooseDiscardIndex(hand, ['north', 'white'], () => 0)
    expect(hand[index]).toBe('m1')
  })
  it('精牌可以被 AI 作为普通牌打出', () => {
    const hand: TileType[] = ['north', 'white', 'east']
    const index = chooseDiscardIndex(hand, ['north', 'white'], () => 0)
    expect(hand[index]).toBe('east')
  })
  it('手里全是精牌时允许兜底打出精牌', () => {
    const hand: TileType[] = ['north', 'white']
    const index = chooseDiscardIndex(hand, ['north', 'white'], () => 0)
    expect(hand[index]).toBe('north')
  })

  it('开局阶段优先保留字牌，不因为孤张直接打出', () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm5', 'm6', 'm7', 'p1', 'p2', 'p3', 'p5', 'p6', 'east', 'south', 'white']
    const index = chooseDiscardIndex(hand, ['white'], () => 0, { exposedMelds: 0, earlyRound: true })
    expect(hand[index]).not.toBe('east')
    expect(hand[index]).not.toBe('south')
  })
})
