import { expect, it } from 'vitest'
import type { Meld, TileType } from '../../../core/contracts/types'
import { TILE_TYPES } from '../../../core/rules/tiles'
import { evaluateWaits, evaluateWin } from '../patterns/evaluate'
import { chainEvEst } from './patternPotentials'
import { forecastCalibratedIncome, forecastSelfDrawIncome, forecastSourceComponents } from './incomeForecast'
import { BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI } from './config'

const concealed = 'm1 m2 m3 s1 s2 s3 p1 p2 p3 east east east m5'.split(' ') as TileType[]
const jokers: TileType[] = ['m5', 'm6']
const input = { concealed, melds: [], jokers, winningTile: 's7' as TileType, opening: null }

it.each(['discard', 'robbed-kong'] as const)('any-wait forbids every external %s tile, including natural completions', source => {
  for (const winningTile of TILE_TYPES) expect(evaluateWin({ ...input, source, winningTile })).toBeNull()
  expect(evaluateWin({ ...input, source, opening: 'earth' })).toBeNull()
})

it.each(['self-draw', 'kong-bloom'] as const)('any-wait retains all 34 %s tiles and source scoring', source => {
  for (const winningTile of TILE_TYPES) expect(evaluateWin({ ...input, source, winningTile })?.score.source).toBe(source)
})

it('applies the same restriction with exposed melds while retaining ordinary ron and robbed-kong', () => {
  const melds: Meld[] = [{ type: 'chi', tile: 'm1', tiles: ['m1', 'm2', 'm3'] }]
  expect(evaluateWin({ ...input, concealed: concealed.slice(3), melds, source: 'discard' })).toBeNull()
  expect(evaluateWin({ ...input, concealed: concealed.slice(3), melds, source: 'kong-bloom' })).not.toBeNull()
  const narrow = [...concealed.slice(0, 12), 's7'] as TileType[]
  for (const source of ['discard', 'robbed-kong'] as const) {
    expect(evaluateWin({ ...input, concealed: narrow, source })).not.toBeNull()
  }
})

it('wait previews and ordinary AI count only self-draw income for any-wait', () => {
  const waits = evaluateWaits(input)
  expect(waits).toHaveLength(34)
  expect(waits.every(wait => wait.selfDraw && wait.discard === null)).toBe(true)
  const c = forecastSourceComponents(concealed, [], jokers, concealed, 32, 8)
  expect(c.selfPerDraw).toBeGreaterThan(0)
  expect(c.ronPerDiscard).toBe(0)
  expect(forecastCalibratedIncome(concealed, [], jokers, concealed, 3, 8, 4, BLOOD_FLOW_AI.opportunityCalibration!)).toBe(0)
})

it('LLM legacy forecasts use actual own draws for any-wait, including seat offset and horizon', () => {
  const chain = (wall: number, offset = 4) => chainEvEst(concealed, [], jokers, concealed, wall, 'ev', BLOOD_FLOW_LLM_AI, offset)
  expect(chain(3)).toBe(0)
  expect(chain(4)).toBeCloseTo(forecastSelfDrawIncome(concealed, [], jokers, concealed, 4, 8))
  expect(chain(3, 1)).toBeGreaterThan(0)
  expect(chain(8)).toBeCloseTo(chain(4) * 2)
})
