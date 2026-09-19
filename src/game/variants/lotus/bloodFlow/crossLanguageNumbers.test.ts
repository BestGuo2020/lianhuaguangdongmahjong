// 跨语言数值护栏（前端侧）——与后端镜像测试共用同一组 fixtures 与同一组数字。
//
//   · 后端：backend/tests/test_blood_flow_kong_value.py::test_kong_value_matches_ts_engine_numbers
//           backend/tests/test_blood_flow_seven_pairs_model.py::test_cross_language_guard
//   · 前端：本文件
//
// 为什么要有这一侧：2026-09-18 豪华七对 12 → 6 番时只改了前端断言与后端 config，
// 后端镜像测试的期望值留在 12 番时代，于是 9 例护栏静默失效、直到全量跑才发现。
// 现在改番值/权重会**同时**打断前后端两侧的护栏，逼着两边一起更新（数字即合同）。
//
// 注：`off` 口径（不含番值）与「豪华七对进度」不受番值影响；`ev` 口径随番值变动。
import { describe, expect, it } from 'vitest'
import type { TileType } from '../../../core/contracts/types'
import { BLOOD_FLOW_CONFIG } from './config'
import { kongCandidateValue, kongGain, kongSelfLoss } from './kongValue'
import { patternPotentialTotal, patternPotentials } from './patternPotentials'

const JOKERS: TileType[] = ['red']
const WILD: TileType[] = ['red', 'white']

/** 与后端同名 fixtures：和别人打出的 m3 能大明杠（3 张 m3 + 4 对 + 2 散张）。 */
const LUXURY_ROUTE: TileType[] = ['m3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 's3', 's3', 'p7', 's8']
/** 七对路线已废：只有 3 对。 */
const SEVEN_PAIRS_DEAD: TileType[] = ['m5', 'm5', 'm5', 'm1', 'm1', 'm2', 'm2', 'p4', 'p5', 'p6', 's7', 's9', 'east']
/** 门清听牌：四副面子 + 单张 east。 */
const CONCEALED_TENPAI: TileType[] = ['m5', 'm5', 'm5', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east']
/** 四张在手（暗杠会拆豪华七对），七对只差两对。 */
const LUXURY_KONG_ROUTE: TileType[] = ['m3', 'm3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 's3', 's3', 'p7', 's8']
/** 已成形的豪华七对（四张 + 5 对）。 */
const LUXURY_COMPLETE: TileType[] = ['m3', 'm3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 's3', 's3', 'p7', 'p7']

const H1: TileType[] = ['m4', 'm4', 'm4', 'm3', 'm3', 'm5', 'm5', 's5', 's5', 'p6', 'p6', 'east', 'east']
const H2: TileType[] = ['m4', 'm4', 'm4', 'm4', 'm3', 'm3', 's5', 's5', 'p6', 'p6', 'east', 'east', 'south']
const H3: TileType[] = ['m3', 'm3', 'm4', 'm4', 'm4', 's5', 's5', 'p6', 'p6', 'red', 'red', 'm7', 'm9']
const H4: TileType[] = ['m3', 'm3', 's5', 's5', 'p6', 'p6', 'm7', 'm7', 'p8', 'p8', 'red', 'red', 'red']
const H5: TileType[] = ['m4', 'm4', 'm4', 'm3', 'm3', 's5', 's5', 'p6', 'p6', 'm7', 'm7', 'east', 'red']
const H6: TileType[] = ['m3', 'm3', 's5', 's5', 'p6', 'p6', 'm7', 'm7', 'p8', 'p8', 's9', 's9', 'east']

const direction = (hand: TileType[], id: string) =>
  patternPotentials(hand, [], JOKERS, 'ev').find(item => item.id === id)!

describe('跨语言护栏：开杠价值（与后端镜像同数字）', () => {
  it('杠收益阶梯：明杠 20 / 补杠 40 / 暗杠 80 / 风杠 70（2026-09-15 起风杠与明杠同档）', () => {
    expect(BLOOD_FLOW_CONFIG.basePoints).toBe(10)
    expect(kongGain('discard-gang')).toBe(20)
    expect(kongGain('added-kong')).toBe(40)
    expect(kongGain('concealed-kong')).toBe(80)
    expect(kongGain('wind-kong')).toBe(70)
  })

  it('七对路线成立（差两对）时的自手损失：31.43（12 番时代为 42.4）', () => {
    const route = kongCandidateValue({ kind: 'discard-gang', hand: LUXURY_ROUTE, melds: [], jokers: JOKERS, tile: 'm3' })
    expect(route.gain).toBe(20)
    expect(route.risk).toBe(0)
    expect(route.selfLoss.sevenPairs).toBeCloseTo(31.43, 2)
    expect(route.selfLoss.concealedHand).toBeCloseTo(3, 3)
    expect(route.selfLoss.total).toBeCloseTo(44.43, 2)
    expect(route.net).toBeCloseTo(-24.43, 2)
    expect(route.selfLoss.reasons.join()).toContain('七对')
  })

  it('四张在手（拆豪华七对）：单项 73.47 已低于杠分 80，但总损失 83.47 仍压过 → 不暗杠', () => {
    const value = kongCandidateValue({ kind: 'concealed-kong', hand: LUXURY_KONG_ROUTE, melds: [], jokers: JOKERS, tile: 'm3' })
    expect(value.selfLoss.sevenPairs).toBeCloseTo(73.47, 2)
    // 2026-09-15 起暗杠保留门清 → 不计「破坏门清」。
    expect(value.selfLoss.concealedHand).toBe(0)
    expect(value.selfLoss.total).toBeCloseTo(83.47, 2)
    expect(value.selfLoss.sevenPairs).toBeLessThan(value.gain)
    expect(value.selfLoss.total).toBeGreaterThan(value.gain)
    expect(kongSelfLoss({ kind: 'concealed-kong', hand: LUXURY_KONG_ROUTE, melds: [], jokers: JOKERS, tile: 'm3' }).sevenPairs)
      .toBeCloseTo(73.47, 2)
  })

  it('已成形的豪华七对（四张 + 5 对）：单项 100（12 番时代 160）、净值 -30（原 -90）', () => {
    const win = kongCandidateValue({ kind: 'concealed-kong', hand: LUXURY_COMPLETE, melds: [], jokers: JOKERS, tile: 'm3' })
    expect(win.selfLoss.sevenPairs).toBeCloseTo(100, 3)
    expect(win.selfLoss.concealedHand).toBe(0)
    expect(win.net).toBeCloseTo(-30, 3)
  })

  it('门清听牌 / 七对已废两手：5 与 3 的自损、净值 15 与 17', () => {
    const tenpai = kongCandidateValue({ kind: 'discard-gang', hand: CONCEALED_TENPAI, melds: [], jokers: JOKERS, tile: 'm5' })
    expect(tenpai.selfLoss.concealedHand).toBeCloseTo(5, 3)
    expect(tenpai.net).toBeCloseTo(15, 3)
    const dead = kongCandidateValue({ kind: 'discard-gang', hand: SEVEN_PAIRS_DEAD, melds: [], jokers: JOKERS, tile: 'm5' })
    expect(dead.selfLoss.sevenPairs).toBe(0)
    expect(dead.selfLoss.concealedHand).toBeCloseTo(3, 3)
    expect(dead.net).toBeCloseTo(17, 3)
  })
})

describe('跨语言护栏：七对潜力合计与豪华方向（与后端镜像同数字）', () => {
  it('豪华七对权重是 6 番；裸刻子（可达性 0.6）时豪华方向让位于普通七对', () => {
    expect(BLOOD_FLOW_CONFIG.patterns['luxury-seven-pairs'].weight).toBe(6)
    expect(direction(H1, 'luxury-seven-pairs').score).toBeCloseTo(1.586939, 6)
    expect(direction(H1, 'sevenPairs').score).toBeCloseTo(2.938776, 6)
    expect(direction(H1, 'luxury-seven-pairs').score).toBeLessThan(direction(H1, 'sevenPairs').score)
  })

  it.each([
    ['H1', H1, 11.522602, 13.109541, 0.514286],
    ['H2', H2, 11.522602, 15.930765, 0.857143],
    ['H3', H3, 58.036080, 62.444243, 0.857143],
    ['H4', H4, 92.798213, 98.104335, 0.857143],
    ['H5', H5, 23.109058, 27.517221, 0.857143],
    ['H6', H6, 7.530491, 7.706818, 0.171429],
  ])('%s：off 合计 / ev 合计 / 豪华进度 逐位一致', (_name, hand, offTotal, evTotal, progress) => {
    expect(patternPotentialTotal(hand as TileType[], [], JOKERS, 'off')).toBeCloseTo(offTotal as number, 3)
    expect(patternPotentialTotal(hand as TileType[], [], JOKERS, 'ev')).toBeCloseTo(evTotal as number, 3)
    expect(direction(hand as TileType[], 'luxury-seven-pairs').progress).toBeCloseTo(progress as number, 3)
  })

  it('wildcard 口径固定为 red + white（与后端 WILD 常量一致）', () => {
    expect(WILD).toEqual(['red', 'white'])
  })
})
