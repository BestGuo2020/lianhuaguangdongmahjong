import { describe, expect, it } from 'vitest'
import {
  formatDelta,
  formatMatchDate,
  formatPosition,
  formatRank,
  formatTurn,
  matchSubtitle,
  meldLabel,
  rankTone,
  roundLabelFor,
  stepSummary,
} from './format'
import type { ReplayStep } from './types'

const NOON = new Date(2026, 8, 14, 12, 0, 0).getTime()

describe('回放列表文案', () => {
  it('对局日期：今天只显示时刻，本年内显示月日，跨年带年份', () => {
    const today = new Date(2026, 8, 14, 21, 3, 0).getTime()
    expect(formatMatchDate(today, NOON)).toBe('21:03')

    const earlier = new Date(2026, 8, 12, 9, 5, 0).getTime()
    expect(formatMatchDate(earlier, NOON)).toBe('9月12日 09:05')

    const lastYear = new Date(2025, 11, 31, 23, 59, 0).getTime()
    expect(formatMatchDate(lastYear, NOON)).toBe('2025年12月31日')

    expect(formatMatchDate(0, NOON)).toBe('—')
    expect(formatMatchDate(Number.NaN, NOON)).toBe('—')
  })

  it('位次：1~4 位，缺失显示破折号并给出配色档', () => {
    expect(formatRank(1)).toBe('1位')
    expect(formatRank(4)).toBe('4位')
    expect(formatRank(undefined)).toBe('—')
    expect(formatRank(0)).toBe('—')
    expect(rankTone(1)).toBe('first')
    expect(rankTone(2)).toBe('second')
    expect(rankTone(3)).toBe('third')
    expect(rankTone(4)).toBe('fourth')
    expect(rankTone(undefined)).toBe('none')
  })

  it('净胜分带符号', () => {
    expect(formatDelta(13200)).toBe('+13200')
    expect(formatDelta(-800)).toBe('-800')
    expect(formatDelta(0)).toBe('±0')
    expect(formatDelta(undefined)).toBe('±0')
  })

  it('局数与巡目', () => {
    expect(roundLabelFor(1, 'east')).toBe('东1局')
    expect(roundLabelFor(4, 'east')).toBe('东4局')
    expect(roundLabelFor(5, 'hanchan')).toBe('南1局')
    expect(roundLabelFor(8, 'hanchan')).toBe('南4局')
    expect(formatTurn(1)).toBe('1巡')
    expect(formatTurn(12)).toBe('12巡')
    expect(formatTurn(0)).toBe('1巡')
    expect(formatPosition(3, 37)).toBe('3/37')
  })

  it('列表副标题区分已完成与未完成', () => {
    expect(matchSubtitle({ roundCount: 4, myRank: 2, myScore: 13200, status: 'finished' }))
      .toBe('4局 · 2位 · +13200分')
    expect(matchSubtitle({ roundCount: 2, myRank: undefined, myScore: -300, status: 'aborted' }))
      .toBe('2局 · 未完成')
  })
})

describe('牌谱事件文案', () => {
  const base: ReplayStep = { t: 'draw', seat: 0, wallLeft: 60, headDrawn: 20, currentPlayer: 0 }

  it('摸牌 / 补牌 / 出牌', () => {
    expect(stepSummary({ ...base, tile: 'm5' })).toBe('摸 五万')
    expect(stepSummary({ ...base, tile: 'm5', fromTail: true })).toBe('补牌 五万')
    expect(stepSummary({ ...base, t: 'discard', tile: 'p3' })).toBe('打 三筒')
  })

  it('鸣牌与胡牌', () => {
    expect(stepSummary({ ...base, t: 'meld', kind: 'peng', tile: 's7' })).toBe('碰 七条')
    expect(stepSummary({ ...base, t: 'meld', kind: 'gang-concealed', tile: 'east' })).toBe('暗杠 东风')
    expect(stepSummary({ ...base, t: 'meld', kind: 'gang-wind', tile: 'north' })).toBe('风杠 北风')
    expect(stepSummary({ ...base, t: 'win', actionType: 'self-draw', tile: 'm9' })).toBe('自摸 九万')
    expect(stepSummary({ ...base, t: 'win', actionType: 'discard-win', tile: 'm9' })).toBe('胡 九万')
    expect(stepSummary({ ...base, t: 'win', actionType: 'robbed-kong-win', tile: 'm9' })).toBe('抢杠胡 九万')
  })

  it('鸣牌标签有兜底', () => {
    expect(meldLabel('chi')).toBe('吃')
    expect(meldLabel(undefined)).toBe('鸣牌')
  })
})
