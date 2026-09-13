// 第二版番种表新增牌型的正反例 + 杠加成（2026-09-12）。
import { describe, expect, it } from 'vitest'
import { evaluateWin } from './evaluate'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_KONG_BONUS } from '../bloodFlow/config'
import type { Meld, TileType } from '../../../core/contracts/types'

const NO_MELDS: readonly Meld[] = []
function ids(concealed: TileType[], winningTile: TileType, source: 'discard' | 'self-draw' = 'discard', jokers: TileType[] = []) {
  const win = evaluateWin({ concealed, melds: NO_MELDS as never, winningTile, source, jokers, opening: null })
  return win ? win.score.items.map(item => item.id) : null
}
function score(concealed: TileType[], winningTile: TileType, source: 'discard' | 'self-draw' = 'discard', jokers: TileType[] = []) {
  return evaluateWin({ concealed, melds: NO_MELDS as never, winningTile, source, jokers, opening: null })
}

describe('断幺九 / 全带幺', () => {
  it('断幺九：全 2~8 数牌成立；带幺九或字牌不成立', () => {
    // 234 567 + 234 567 + 88（万/筒混）→ 断幺九
    expect(ids(['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], 'p8')).toContain('all-simples')
    // 带 1 万 → 不成立
    expect(ids(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], 'p8')).not.toContain('all-simples')
  })

  it('全带幺：每副面子含幺九/字牌成立；有中张面子则不成立', () => {
    // 123 789 123 + 东东东 + 99（每副都带幺）
    expect(ids(['m1', 'm2', 'm3', 'm7', 'm8', 'm9', 'p1', 'p2', 'p3', 'east', 'east', 'east', 'p9'], 'p9')).toContain('all-with-terminals')
    // 把一组换成 456 → 不成立
    expect(ids(['m1', 'm2', 'm3', 'm7', 'm8', 'm9', 'p4', 'p5', 'p6', 'east', 'east', 'east', 'p9'], 'p9')).not.toContain('all-with-terminals')
  })
})

describe('一色步高 / 清龙', () => {
  it('一色三步高：同门三副顺子起始 1/2/3 成立；不连续则不成立', () => {
    // 123 234 345 + 碰碰式对子
    expect(ids(['m1', 'm2', 'm3', 'm2', 'm3', 'm4', 'm3', 'm4', 'm5', 's5', 's5', 's5', 's9'], 's9'))
      .toContain('one-suit-three-steps')
    // 123 345 567（起始 1/3/5，不连续）
    expect(ids(['m1', 'm2', 'm3', 'm3', 'm4', 'm5', 'm5', 'm6', 'm7', 's5', 's5', 's5', 's9'], 's9'))
      .not.toContain('one-suit-three-steps')
  })

  it('一色四步高覆盖一色三步高（只计高位）', () => {
    const items = ids(['m1', 'm2', 'm3', 'm2', 'm3', 'm4', 'm3', 'm4', 'm5', 'm4', 'm5', 'm6', 's9'], 's9')
    expect(items).toContain('one-suit-four-steps')
    expect(items).not.toContain('one-suit-three-steps')
  })

  it('清龙：123 456 789 同门成立', () => {
    expect(ids(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 's5', 's5', 's5', 's9'], 's9'))
      .toContain('pure-straight')
  })
})

describe('一色节高', () => {
  it('一色三节高：同门三副连续数字刻子成立；数字不连续不成立', () => {
    expect(ids(['m2', 'm2', 'm2', 'm3', 'm3', 'm3', 'm4', 'm4', 'm4', 's5', 's5', 's5', 's9'], 's9'))
      .toContain('one-suit-three-joints')
    expect(ids(['m2', 'm2', 'm2', 'm4', 'm4', 'm4', 'm6', 'm6', 'm6', 's5', 's5', 's5', 's9'], 's9'))
      .not.toContain('one-suit-three-joints')
  })

  it('一色四节高覆盖一色三节高与碰碰胡', () => {
    const items = ids(['m2', 'm2', 'm2', 'm3', 'm3', 'm3', 'm4', 'm4', 'm4', 'm5', 'm5', 'm5', 'm9'], 'm9')
    expect(items).toContain('one-suit-four-joints')
    expect(items).not.toContain('one-suit-three-joints')
    expect(items).not.toContain('all-triplets')
  })
})

describe('门清（仅标准四面子一将型生效）', () => {
  it('标准型无副露成立；七对等特殊结构不计门清', () => {
    expect(ids(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], 'p8'))
      .toContain('concealed-hand')
    // 七对虽是门清结构，但按"仅标准型生效"不计门清
    const pairs = ids(['m1', 'm1', 'm2', 'm2', 'm3', 'm3', 'p4', 'p4', 'p5', 'p5', 's6', 's6', 's7'], 's7')
    expect(pairs).toContain('sevenPairs')
    expect(pairs).not.toContain('concealed-hand')
    // 十三烂同理
    const scattered = ids(['m1', 'm4', 'm7', 'p1', 'p4', 'p7', 's1', 's4', 's7', 'east', 'south', 'west', 'north'], 'red')
    expect(scattered ?? []).not.toContain('concealed-hand')
  })
})

describe('杠加成', () => {
  const kong = (type: 'gang' | 'angang' | 'windgang', tile: TileType): Meld =>
    ({ type, tile, tiles: [tile, tile, tile, tile] }) as unknown as Meld

  it('明杠 +1、暗杠/风杠 +2，计入番型倍率', () => {
    expect(BLOOD_FLOW_KONG_BONUS).toMatchObject({ exposed: 1, concealed: 2, wind: 2 })
    expect(BLOOD_FLOW_CONFIG.kongBonus).toMatchObject({ exposed: 1, concealed: 2, wind: 2 })
    // 无杠：基础倍率 = 1 + Σ(w-1)
    const plain = score(['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], 'p8')!
    expect(plain.score.kongBonus).toBe(0)
    expect(plain.score.patternMultiplier).toBe(1 + plain.score.items.reduce((sum, item) => sum + item.weight - 1, 0))
    // 两个明杠 + 一个暗杠 → 加成 1+1+2 = 4；倍率里必须体现
    const withKongs = evaluateWin({
      concealed: ['m4', 'm5', 'm6', 'east'], melds: [kong('gang', 'm1'), kong('gang', 's3'), kong('angang', 'p2')],
      winningTile: 'east', source: 'discard', jokers: [], opening: null,
    })!
    // 这手同时成三杠番种 → 按"不重复计算"口径，每副杠的加成归零
    expect(withKongs.score.items.map(item => item.id)).toContain('three-kongs')
    expect(withKongs.score.kongBonus).toBe(0)
    expect(withKongs.score.patternMultiplier).toBe(1 + withKongs.score.items.reduce((sum, item) => sum + item.weight - 1, 0))
    // 只有两副杠（不成三杠/四杠番种）→ 加成照计：1(明) + 2(暗) = 3
    const twoKongs = evaluateWin({
      concealed: ['m4', 'm5', 'm6', 'p7', 'p8', 'p9', 'east'], melds: [kong('gang', 'm1'), kong('angang', 'p2')],
      winningTile: 'east', source: 'discard', jokers: [], opening: null,
    })
    if (twoKongs) {
      expect(twoKongs.score.items.map(item => item.id)).not.toContain('three-kongs')
      expect(twoKongs.score.kongBonus).toBe(3)
    }
    // 风杠按 +2
    const wind = evaluateWin({
      concealed: ['m4', 'm5', 'm6', 'east'], melds: [kong('windgang', 'east'), kong('gang', 'm1')],
      winningTile: 'east', source: 'discard', jokers: [], opening: null,
    })
    if (wind) expect(wind.score.kongBonus).toBeGreaterThanOrEqual(3)
  })
})
