import { describe, expect, it } from 'vitest'
import type { TileType } from '../../../core/contracts/types'
import { evaluateWin } from './evaluate'

const pairs = (...tiles: TileType[]): TileType[] => tiles.flatMap(tile => [tile, tile])

const cases: { name: string; hand: TileType[]; jokers?: TileType[]; items: string[]; multiplier: number; natural?: boolean }[] = [
  { name: '七对＋断幺九', hand: pairs('m2', 'm4', 'p3', 'p5', 's2', 's6', 's8'), items: ['sevenPairs', 'all-simples'], multiplier: 7 },
  { name: '豪华七对＋断幺九', hand: pairs('m2', 'm2', 'p3', 'p5', 's2', 's6', 's8'), items: ['luxury-seven-pairs', 'all-simples'], multiplier: 9 },
  { name: '七对＋清一色', hand: pairs('m1', 'm2', 'm4', 'm5', 'm6', 'm8', 'm9'), items: ['sevenPairs', 'pure-suit'], multiplier: 13 },
  { name: '豪华七对＋清一色', hand: pairs('m1', 'm1', 'm3', 'm5', 'm7', 'm8', 'm9'), items: ['luxury-seven-pairs', 'pure-suit'], multiplier: 15 },
  { name: '七对＋混一色', hand: pairs('m1', 'm3', 'm5', 'm7', 'm9', 'east', 'south'), items: ['sevenPairs', 'mixed-suit'], multiplier: 9 },
  { name: '豪华七对＋混一色', hand: pairs('m1', 'm1', 'm3', 'm5', 'm7', 'east', 'south'), items: ['luxury-seven-pairs', 'mixed-suit'], multiplier: 11 },
  { name: '七对＋混幺九', hand: pairs('m1', 'm9', 'p1', 'p9', 's1', 's9', 'east'), items: ['sevenPairs', 'mixed-terminals'], multiplier: 17 },
  { name: '豪华七对＋混幺九', hand: pairs('m1', 'm1', 'm9', 'p1', 'p9', 'east', 'south'), items: ['luxury-seven-pairs', 'mixed-terminals'], multiplier: 19 },
  // 清幺九只有六种数牌；七对必有四张同牌，因此按豪华七对计分。
  { name: '豪华七对＋清幺九', hand: pairs('m1', 'm1', 'm9', 'p1', 'p9', 's1', 's9'), items: ['luxury-seven-pairs', 'pure-terminals'], multiplier: 31 },
  { name: '豪华七对＋混幺九＋混一色', hand: pairs('m1', 'm1', 'm9', 'east', 'south', 'west', 'north'), items: ['luxury-seven-pairs', 'mixed-terminals', 'mixed-suit'], multiplier: 23 },
  { name: '豪华七对＋断幺九＋清一色', hand: pairs('m2', 'm2', 'm4', 'm5', 'm6', 'm7', 'm8'), items: ['luxury-seven-pairs', 'all-simples', 'pure-suit'], multiplier: 17 },
  { name: '精牌补成七对＋混幺九', hand: [...pairs('m1', 'm9', 'p1', 'p9', 's1'), 's9', 'red', ...pairs('east')], jokers: ['red'], items: ['sevenPairs', 'mixed-terminals'], multiplier: 17, natural: false },
  { name: '精牌补成豪华七对＋混幺九', hand: ['m1', 'm1', 'm1', 'red', ...pairs('m9', 'p1', 'p9', 'east', 'south')], jokers: ['red'], items: ['luxury-seven-pairs', 'mixed-terminals'], multiplier: 19, natural: false },
  { name: '精牌补成豪华七对＋清幺九', hand: [...pairs('m1', 'm1', 'm9', 'p1', 'p9', 's1'), 'red', 's9'], jokers: ['red'], items: ['luxury-seven-pairs', 'pure-terminals'], multiplier: 31, natural: false },
]

describe.each(cases)('$name', fixture => {
  it.each(['discard', 'self-draw'] as const)('叠加番型与实际支付一致：%s', source => {
    const win = evaluateWin({ concealed: fixture.hand.slice(0, -1), winningTile: fixture.hand.at(-1)!, melds: [],
      jokers: fixture.jokers ?? [], source, opening: null })!
    expect(win).not.toBeNull()
    expect(win.decomposition.shape).toBe('sevenPairs')
    expect(win.score.items.map(item => item.id).sort()).toEqual(['concealed-hand', ...fixture.items].sort())
    expect(win.score.patternMultiplier).toBe(fixture.multiplier)
    expect(win.score.hardWin).toBe(fixture.natural !== false)
    expect(win.score.paymentPerPayer).toBe(10 * fixture.multiplier * (source === 'self-draw' ? 2 : 1) * (fixture.natural !== false ? 2 : 1))
    if (fixture.items.includes('luxury-seven-pairs')) {
      expect(win.score.excluded).toContainEqual({ id: 'sevenPairs', includedBy: 'luxury-seven-pairs' })
    }
    expect(win.score.items.map(item => item.id)).not.toContain('all-triplets')
  })
})

it.each([
  { name: '含中张', hand: pairs('m1', 'm9', 'p1', 'p9', 's1', 's2', 'east'), multiplier: 5 },
  { name: '全字牌七对', hand: pairs('east', 'south', 'west', 'north', 'red', 'green', 'white'), multiplier: 29 },
  { name: '全字牌豪华七对', hand: pairs('east', 'east', 'south', 'west', 'north', 'red', 'green'), multiplier: 31 },
])('七对幺九属性反例：$name', fixture => {
  const win = evaluateWin({ concealed: fixture.hand.slice(0, -1), winningTile: fixture.hand.at(-1)!, melds: [],
    jokers: [], source: 'discard', opening: null })!
  expect(win.decomposition.shape).toBe('sevenPairs')
  const ids = win.score.items.map(item => item.id)
  for (const id of ['mixed-terminals', 'pure-terminals', 'all-simples', 'pure-suit', 'mixed-suit']) expect(ids).not.toContain(id)
  expect(win.score.patternMultiplier).toBe(fixture.multiplier)
})
