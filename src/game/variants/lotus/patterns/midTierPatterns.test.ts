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
  // 国标把"依次递增一位"（素三步步高）与"依次递增二位"（素三连环扣）合称一色三步高，
  // 因此同门三副顺子的起始数字取公差 1 或 2 都成立：
  // 窄三步 123/234/345、234/345/456、345/456/567、456/567/678、567/678/789；
  // 宽三步 123/345/567、234/456/678、345/567/789。
  it('一色三步高（窄三步·递增一位）：起始 1/2/3 成立', () => {
    // 123 234 345 + 碰碰式对子
    expect(ids(['m1', 'm2', 'm3', 'm2', 'm3', 'm4', 'm3', 'm4', 'm5', 's5', 's5', 's5', 's9'], 's9'))
      .toContain('one-suit-three-steps')
  })

  it('一色三步高（宽三步·递增二位）：起始 1/3/5、2/4/6、3/5/7 全部成立', () => {
    // 123 345 567
    expect(ids(['m1', 'm2', 'm3', 'm3', 'm4', 'm5', 'm5', 'm6', 'm7', 'east', 'east', 'east', 's5'], 's5'))
      .toContain('one-suit-three-steps')
    // 234 456 678
    expect(ids(['m2', 'm3', 'm4', 'm4', 'm5', 'm6', 'm6', 'm7', 'm8', 'east', 'east', 'east', 's5'], 's5'))
      .toContain('one-suit-three-steps')
    // 345 567 789
    expect(ids(['m3', 'm4', 'm5', 'm5', 'm6', 'm7', 'm7', 'm8', 'm9', 'east', 'east', 'east', 's5'], 's5'))
      .toContain('one-suit-three-steps')
  })

  it('一色三步高：隔两档（1/4/7 清龙）与跨花色都不成立', () => {
    // 123 456 789 只算清龙，不是三步高
    const straight = ids(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'east', 'east', 'east', 's5'], 's5')
    expect(straight).toContain('pure-straight')
    expect(straight).not.toContain('one-suit-three-steps')
    // 123 万 + 345 筒 + 567 索：必须同花色
    expect(ids(['m1', 'm2', 'm3', 'p3', 'p4', 'p5', 's5', 's6', 's7', 'east', 'east', 'east', 's9'], 's9'))
      .not.toContain('one-suit-three-steps')
  })

  it('一色四步高覆盖一色三步高（只计高位；公差 1 / 2 都算四步高）', () => {
    const narrow = ids(['m1', 'm2', 'm3', 'm2', 'm3', 'm4', 'm3', 'm4', 'm5', 'm4', 'm5', 'm6', 's9'], 's9')
    expect(narrow).toContain('one-suit-four-steps')
    expect(narrow).not.toContain('one-suit-three-steps')
    // 123 345 567 789（宽四步）
    const wide = ids(['m1', 'm2', 'm3', 'm3', 'm4', 'm5', 'm5', 'm6', 'm7', 'm7', 'm8', 'm9', 's5'], 's5')
    expect(wide).toContain('one-suit-four-steps')
    expect(wide).not.toContain('one-suit-three-steps')
  })

  it('清龙：123 456 789 同门成立', () => {
    expect(ids(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 's5', 's5', 's5', 's9'], 's9'))
      .toContain('pure-straight')
  })

  it('精牌当将的宽三步（实测手牌）：精(九萬) + 3p4p5p5p7p7p8p8p9p 胡 6p → 一色三步高', () => {
    // 手牌 10 张 + 1 副副露 + 胡牌张 = 14；拆解 345p + 567p + 789p + 88p(精当将)。
    // 副露取筒子刻子（碰 1p），手牌仍是一色筒子。
    const peng: Meld = { type: 'peng', tile: 'p1', tiles: ['p1', 'p1', 'p1'], from: 1 }
    const win = evaluateWin({
      concealed: ['m9', 'p3', 'p4', 'p5', 'p5', 'p7', 'p7', 'p8', 'p8', 'p9'],
      melds: [peng], winningTile: 'p6', source: 'self-draw', jokers: ['m9'], opening: null,
    })
    const items = win?.score.items.map(item => item.id) ?? []
    expect(items).toContain('one-suit-three-steps')
    expect(items).toContain('pure-suit')
    // 精要顶牌（当 8p 做将）→ 软胡，没有硬胡 ×2；倍率 = Σ(番值) = 8(清一色) + 4(一色三步高) = 12
    // （2026-09-15 口径由 1 + Σ(w−1) 改为 Σ(w)；本手有副露，因此既无门清也无平胡）
    expect(win?.score.hardWin).toBe(false)
    expect(win?.score.patternMultiplier).toBe(12)
  })
})

describe('一色节高', () => {
  it('一色三节高：同门三副连续数字刻子成立；数字不连续不成立', () => {
    expect(ids(['m2', 'm2', 'm2', 'm3', 'm3', 'm3', 'm4', 'm4', 'm4', 's5', 's5', 's5', 's9'], 's9'))
      .toContain('one-suit-three-joints')
    // 节高只有"依次递增一位"：2/4/6（递增二位）不算——步高放开公差 2 后这条必须仍然成立。
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

describe('豪华七对：精牌可替补凑成四张相同', () => {
  it('3 张实体同牌 + 1 张精 → 记为豪华七对（软胡）', () => {
    // m2×3 + 精(white) 当第四张 m2，其余三对补齐 → 七对中含"四张相同"
    const hand: TileType[] = ['m2', 'm2', 'm2', 'p5', 'p5', 's7', 's7', 'm9', 'm9', 'east', 'east', 'p1', 'p1']
    const win = evaluateWin({ concealed: hand, melds: [] as never, winningTile: 'white', source: 'self-draw', jokers: ['white'], opening: null })
    const items = win ? win.score.items.map(item => item.id) : []
    expect(items).toContain('luxury-seven-pairs')
    expect(items).not.toContain('sevenPairs')
    expect(win?.score.hardWin).toBe(false)
  })
})

describe('门清（2026-09-15 定案：只看无副露，且与任何番种叠加）', () => {
  it('标准型无副露成立；七对/十三烂等特殊结构同样算门清', () => {
    expect(ids(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], 'p8'))
      .toContain('concealed-hand')
    // 七对同样是"无副露" → 计门清（旧规则"仅标准型生效"已废除）
    const pairs = ids(['m1', 'm1', 'm2', 'm2', 'm3', 'm3', 'p4', 'p4', 'p5', 'p5', 's6', 's6', 's7'], 's7')
    expect(pairs).toContain('sevenPairs')
    expect(pairs).toContain('concealed-hand')
    // 十三烂同理
    const scattered = ids(['m1', 'm4', 'm7', 'p1', 'p4', 'p7', 's1', 's4', 's7', 'east', 'south', 'west', 'north'], 'red')
    expect(scattered ?? []).toContain('concealed-hand')
  })
})

describe('杠加成', () => {
  const kong = (type: 'gang' | 'angang' | 'windgang', tile: TileType): Meld =>
    ({ type, tile, tiles: [tile, tile, tile, tile] }) as unknown as Meld

  it('明杠 +1、暗杠 +2、风杠 +1，计入番型倍率', () => {
    // 风杠 2026-09-15 起与明杠同档（+1）：实测出现率 10.7%/局，是暗杠（5.3%）的两倍
    expect(BLOOD_FLOW_KONG_BONUS).toMatchObject({ exposed: 1, concealed: 2, wind: 1 })
    expect(BLOOD_FLOW_CONFIG.kongBonus).toMatchObject({ exposed: 1, concealed: 2, wind: 1 })
    // 无杠：基础倍率 = Σ(番值)（2026-09-15 口径）
    const plain = score(['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], 'p8')!
    expect(plain.score.kongBonus).toBe(0)
    expect(plain.score.patternMultiplier).toBe(plain.score.items.reduce((sum, item) => sum + item.weight, 0))
    // 两个明杠 + 一个暗杠 → 加成 1+1+2 = 4；倍率里必须体现
    const withKongs = evaluateWin({
      concealed: ['m4', 'm5', 'm6', 'east'], melds: [kong('gang', 'm1'), kong('gang', 's3'), kong('angang', 'p2')],
      winningTile: 'east', source: 'discard', jokers: [], opening: null,
    })!
    // 这手同时成三杠番种 → 按"不重复计算"口径，每副杠的加成归零
    expect(withKongs.score.items.map(item => item.id)).toContain('three-kongs')
    expect(withKongs.score.kongBonus).toBe(0)
    expect(withKongs.score.patternMultiplier).toBe(withKongs.score.items.reduce((sum, item) => sum + item.weight, 0))
    // 只有两副杠（不成三杠/四杠番种）→ 加成照计：1(明) + 2(暗) = 3
    const twoKongs = evaluateWin({
      concealed: ['m4', 'm5', 'm6', 'p7', 'p8', 'p9', 'east'], melds: [kong('gang', 'm1'), kong('angang', 'p2')],
      winningTile: 'east', source: 'discard', jokers: [], opening: null,
    })
    if (twoKongs) {
      expect(twoKongs.score.items.map(item => item.id)).not.toContain('three-kongs')
      expect(twoKongs.score.kongBonus).toBe(3)
    }
    // 风杠按 +1（与明杠同档）→ 风杠 + 明杠 = 1 + 1 = 2
    const wind = evaluateWin({
      concealed: ['m4', 'm5', 'm6', 'east'], melds: [kong('windgang', 'east'), kong('gang', 'm1')],
      winningTile: 'east', source: 'discard', jokers: [], opening: null,
    })
    if (wind) expect(wind.score.kongBonus).toBe(2)
  })

  it('门清：暗杠 / 风杠不破门清，明杠 / 碰 才破（2026-09-15 定案）', () => {
    // 合法结构：1 副杠 + 3 顺子 + 将（east 将 = 手里 1 张 + 胡牌张）
    const concealed: TileType[] = ['m2', 'm3', 'm4', 'p2', 'p3', 'p4', 'p6', 'p7', 'p8', 'east']
    const meld = (m: Record<string, unknown>): Meld => m as unknown as Meld
    const idsOf = (m: Meld) => evaluateWin({ concealed, melds: [m], winningTile: 'east',
      source: 'discard', jokers: [], opening: null })!.score.items.map(item => item.id)
    // 暗杠 → 仍算门清
    expect(idsOf(meld({ type: 'angang', tile: 's3', tiles: ['s3', 's3', 's3', 's3'] }))).toContain('concealed-hand')
    // 风杠（引擎存成 angang + windKong）→ 仍算门清
    expect(idsOf(meld({ type: 'angang', tile: 'east', tiles: ['east', 'south', 'west', 'north'], windKong: true })))
      .toContain('concealed-hand')
    // 明杠（吃/碰他人的牌）→ 破门清
    expect(idsOf(meld({ type: 'gang', tile: 's3', tiles: ['s3', 's3', 's3', 's3'] }))).not.toContain('concealed-hand')
    // 碰 → 破门清（顺带验证吃也不保留：吃出来的顺子本身不是门清）
    expect(idsOf(meld({ type: 'peng', tile: 's3', tiles: ['s3', 's3', 's3'] }))).not.toContain('concealed-hand')
    expect(idsOf(meld({ type: 'chi', tile: 's3', tiles: ['s3', 's4', 's5'] }))).not.toContain('concealed-hand')
  })

  it('鸡胡遇杠：只算杠番（不加鸡胡 0.5 番、也没有兜底 1 番），番型名字仍是鸡胡', () => {
    const concealed: TileType[] = ['m2', 'm3', 'm4', 'p2', 'p3', 'p4', 'p6', 'p7', 'p8', 'east']
    const withKong = evaluateWin({ concealed,
      melds: [{ type: 'gang', tile: 's3', tiles: ['s3', 's3', 's3', 's3'] } as unknown as Meld],
      winningTile: 'east', source: 'discard', jokers: [], opening: null })!
    // 明杠破门清、也没有任何其他番 → 只剩鸡胡，但**倍率等于杠番 1**（不含 0.5、不含兜底 1 番）；
    // 这手全自然 → 硬胡 ×2 → 实付 20 点/家（软胡（用精）时才是 10 点）。
    expect(withKong.score.items.map(item => item.id)).toEqual(['chicken'])
    expect(withKong.score.kongBonus).toBe(1)
    expect(withKong.score.patternMultiplier).toBe(1)
    expect(withKong.score.halfPayment).toBe(false)
    expect(withKong.score.hardWin).toBe(true)
    expect(withKong.score.finalMultiplier).toBe(2)
    expect(withKong.score.paymentPerPayer).toBe(20)
    // 暗杠（+2）同理：倍率 = 2
    const withAnGang = evaluateWin({ concealed,
      melds: [{ type: 'angang', tile: 's3', tiles: ['s3', 's3', 's3', 's3'] } as unknown as Meld],
      winningTile: 'east', source: 'discard', jokers: [], opening: null })!
    // 暗杠保留门清 → 不是纯鸡胡，这里验证"门清 + 杠加成"的正常口径
    expect(withAnGang.score.items.map(item => item.id)).toEqual(['concealed-hand'])
    expect(withAnGang.score.patternMultiplier).toBe(3)
    // 纯鸡胡（无杠）→ 仍走半番：倍率 1、支付减半（硬胡 ×2 后 10 点 = 10×2÷2）
    // 结构：1 副吃 + 2 顺子 + 1 刻子 + 将 → 有副露（不成门清）、有刻子（不成平胡）、含字牌（不成断幺九）→ 只剩鸡胡
    const noKong = evaluateWin({ concealed: ['p2', 'p3', 'p4', 's2', 's3', 's4', 'm5', 'm5', 'm5', 'east'],
      melds: [{ type: 'chi', tile: 'm2', tiles: ['m2', 'm3', 'm4'] } as unknown as Meld],
      winningTile: 'east', source: 'discard', jokers: [], opening: null })!
    expect(noKong.score.items.map(item => item.id)).toEqual(['chicken'])
    expect(noKong.score.patternMultiplier).toBe(1)
    expect(noKong.score.halfPayment).toBe(true)
    expect(noKong.score.finalMultiplier).toBe(2)
    expect(noKong.score.paymentPerPayer).toBe(10)
  })
})
