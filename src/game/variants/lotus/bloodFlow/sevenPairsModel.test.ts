// 七对潜力模型 v2（2026-09-13，用户定案）：对齐引擎 isSevenPairs 的记账 + 新增豪华七对（12 番）方向。
//
// 背景（引擎实测，见 tmp/luxury-seven-pairs-analysis.test.ts）：
//   · 精牌能把刻子/对子补成四张 → 豪华七对根本不用等第四张（3 张实体 + 1 精即成立）；
//   · 5 对 + 3 精是 34 种全听（29 种豪华七对 + 5 种断幺九+四暗刻）；
//   · 旧口径只算 `pairs + min(singles, jokers)`，**多余精牌丢掉**，于是精越多估值反而越低。
import { describe, expect, it } from 'vitest'
import type { Meld, TileType } from '../../../core/contracts/types'
import { BLOOD_FLOW_CONFIG } from './config'
import {
  estimateWinIncome, luxurySevenPairsProgress, patternPotentialTotal, patternPotentials,
  quadAvailability, sevenPairsAccount, sevenPairsPotential, sevenPairsProgress,
} from './patternPotentials'

const JOKERS: TileType[] = ['red']
const WILD = ['red', 'white'] as TileType[]

/** H1：实体刻子 + 5 对（手上无精）——引擎实测听 m4 与翻精，两者都是豪华七对。 */
const TRIPLET_PLUS_FIVE_PAIRS: TileType[] = ['m4', 'm4', 'm4', 'm3', 'm3', 'm5', 'm5', 's5', 's5', 'p6', 'p6', 'east', 'east']
/** H4：5 对 + 3 精——引擎实测 34 种全听（29 种豪华七对）。 */
const FIVE_PAIRS_THREE_JOKERS: TileType[] = ['m3', 'm3', 's5', 's5', 'p6', 'p6', 'm7', 'm7', 'p8', 'p8', 'red', 'red', 'red']
/** H6：6 对 + 1 散张（真·普通七对，对照）。 */
const SIX_PAIRS_ONE_SINGLE: TileType[] = ['m3', 'm3', 's5', 's5', 'p6', 'p6', 'm7', 'm7', 'p8', 'p8', 's9', 's9', 'east']

const direction = (hand: TileType[], id: string, model: 'off' | 'ev') =>
  patternPotentials(hand, [], JOKERS, model).find(item => item.id === id)

describe('七对账目对齐引擎（pairs / singles / 精牌两两成对）', () => {
  it('刻子记 1 对 + 1 单（不是白拿一对），与 isSevenPairs 同口径', () => {
    const account = sevenPairsAccount(TRIPLET_PLUS_FIVE_PAIRS, WILD)
    expect(account.pairs).toBe(6)
    expect(account.singles).toBe(1)
    expect(account.jokers).toBe(0)
    expect(account.effectivePairs).toBe(6)
  })

  it('多余精牌不再丢掉：5 对 + 3 精 → 有效对子 6（旧口径只有 5）', () => {
    const account = sevenPairsAccount(FIVE_PAIRS_THREE_JOKERS, WILD)
    expect(account.pairs).toBe(5)
    expect(account.singles).toBe(0)
    expect(account.jokers).toBe(3)
    expect(account.effectivePairs).toBe(6) // 3 精里两张自成一对，剩 1 张等补单张
    expect(sevenPairsPotential(FIVE_PAIRS_THREE_JOKERS, WILD)).toBe(20) // 旧口径：5/7
    expect(sevenPairsProgress(FIVE_PAIRS_THREE_JOKERS, WILD)).toBeCloseTo(6 / 7, 6)
  })

  it('精牌只够补单张时两种口径一致（回归护栏）', () => {
    const hand: TileType[] = ['m3', 'm3', 's5', 's5', 'p6', 'p6', 'm7', 'm7', 'p8', 'p8', 'red']
    const account = sevenPairsAccount(hand, WILD)
    expect(account.effectivePairs).toBe(account.pairs + Math.min(account.singles, account.jokers))
  })
})

describe('四张可达性（豪华七对的第二半）', () => {
  it('刻子 + 1 精 = 四张成立（不用等第四张）', () => {
    const hand: TileType[] = ['m4', 'm4', 'm4', 'm3', 'm3', 's5', 's5', 'p6', 'p6', 'red']
    expect(quadAvailability(hand, WILD)).toBe(1)
  })

  it('5 对 + 3 精 → 四张可达性拉满（单张 + 3 精也能补成四张）', () => {
    expect(quadAvailability(FIVE_PAIRS_THREE_JOKERS, WILD)).toBe(1)
  })

  it('只有刻子、没有精 → 0.6；只有对子 → 0.2', () => {
    expect(quadAvailability(TRIPLET_PLUS_FIVE_PAIRS, WILD)).toBe(0.6)
    expect(quadAvailability(SIX_PAIRS_ONE_SINGLE, WILD)).toBe(0.2)
  })
})

describe('豪华七对方向（12 番）与旧口径的对照', () => {
  it("'off' 不含豪华方向，且七对进度与旧 sevenPairsPotential 逐位一致", () => {
    for (const hand of [TRIPLET_PLUS_FIVE_PAIRS, FIVE_PAIRS_THREE_JOKERS, SIX_PAIRS_ONE_SINGLE]) {
      const directions = patternPotentials(hand, [], JOKERS, 'off')
      expect(directions.some(item => item.id === 'luxury-seven-pairs')).toBe(false)
      expect(direction(hand, 'sevenPairs', 'off')?.progress ?? 0)
        .toBeCloseTo(Math.min(1, sevenPairsPotential(hand, WILD) / 28), 6)
    }
  })

  it('刻子 + 5 对（无精）：豪华方向成为七对路线的**最高档**，权重按 12 番算', () => {
    const luxury = direction(TRIPLET_PLUS_FIVE_PAIRS, 'luxury-seven-pairs', 'ev')!
    const seven = direction(TRIPLET_PLUS_FIVE_PAIRS, 'sevenPairs', 'ev')!
    expect(luxury.weight).toBe(BLOOD_FLOW_CONFIG.patterns['luxury-seven-pairs'].weight)
    expect(luxury.progress).toBeCloseTo(sevenPairsProgress(TRIPLET_PLUS_FIVE_PAIRS, WILD) * 0.6, 6)
    expect(luxury.score).toBeGreaterThan(seven.score)
  })

  it('5 对 + 3 精（34 种全听）：新模型估值高于旧口径，方向排名不再反向', () => {
    expect(patternPotentialTotal(FIVE_PAIRS_THREE_JOKERS, [], JOKERS, 'ev'))
      .toBeGreaterThan(patternPotentialTotal(FIVE_PAIRS_THREE_JOKERS, [], JOKERS, 'off'))
    const luxury = direction(FIVE_PAIRS_THREE_JOKERS, 'luxury-seven-pairs', 'ev')!
    expect(luxury.progress).toBeCloseTo(6 / 7, 6)
    expect(luxury.score).toBeGreaterThan(direction(FIVE_PAIRS_THREE_JOKERS, 'sevenPairs', 'ev')!.score)
  })

  it('普通七对形状也会带一条很小的豪华方向（对子还差两张），不喧宾夺主', () => {
    const luxury = direction(SIX_PAIRS_ONE_SINGLE, 'luxury-seven-pairs', 'ev')!
    expect(luxury.progress).toBeLessThan(0.25)
    expect(luxury.score).toBeLessThan(1)
  })
})

describe('收益估算（连锁期望/改张用）也认得豪华七对', () => {
  /** 完整 14 张：3 张实体 m4 + 1 精 + 5 对 = 豪华七对（软胡，含精牌）。 */
  const luxuryWin: TileType[] = ['m4', 'm4', 'm4', 'red', 'm3', 'm3', 's5', 's5', 'p6', 'p6', 'm7', 'm7', 'east', 'east']
  /** 对照：6 对 + 1 张精（普通七对，软胡）。 */
  const plainWin: TileType[] = ['m3', 'm3', 's5', 's5', 'p6', 'p6', 'm7', 'm7', 'p8', 'p8', 's9', 's9', 'north', 'red']

  it('豪华七对按 12 番计价（旧口径按 4 番，差 3 倍）', () => {
    const ev = estimateWinIncome(luxuryWin, [] as Meld[], JOKERS, 'self-draw', 'ev')
    const off = estimateWinIncome(luxuryWin, [] as Meld[], JOKERS, 'self-draw', 'off')
    expect(ev.multiplier).toBe(BLOOD_FLOW_CONFIG.patterns['luxury-seven-pairs'].weight * BLOOD_FLOW_CONFIG.eventMultipliers['self-draw'])
    expect(off.multiplier).toBe(BLOOD_FLOW_CONFIG.patterns.sevenPairs.weight * BLOOD_FLOW_CONFIG.eventMultipliers['self-draw'])
    expect(ev.paymentPerPayer).toBeGreaterThan(off.paymentPerPayer * 2)
  })

  it('普通七对不受影响（两种模式同值）', () => {
    const ev = estimateWinIncome(plainWin, [] as Meld[], JOKERS, 'self-draw', 'ev')
    const off = estimateWinIncome(plainWin, [] as Meld[], JOKERS, 'self-draw', 'off')
    expect(ev).toEqual(off)
  })

  it('豪华七对进度是七对进度与四张可达性的乘积', () => {
    expect(luxurySevenPairsProgress(TRIPLET_PLUS_FIVE_PAIRS, WILD))
      .toBeCloseTo(sevenPairsProgress(TRIPLET_PLUS_FIVE_PAIRS, WILD) * quadAvailability(TRIPLET_PLUS_FIVE_PAIRS, WILD), 9)
  })
})
