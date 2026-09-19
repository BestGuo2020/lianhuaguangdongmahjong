import { expect, it } from 'vitest'
import { decideClaim, type LotusClaimView } from './lotusAi'
import { canChi } from './lotusRules'
import type { Meld, TileType } from '../../core/contracts/types'
import { BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI } from './bloodFlow/config'

const hand: TileType[] = ['m2','m3','m4','m4','m5','m6','p2','p2','p3','p4','s5','s5','east']
const jokers: TileType[] = ['white','red']
function inspect(existing: Meld[] = [], projection = true, withBonus = true) {
  const tiles = hand.slice(0, 13 - existing.length * 3)
  const calls: { hand: TileType[]; melds: Meld[] }[] = []
  const view: LotusClaimView = { hand: tiles, melds: existing, exposedMelds: existing.length,
    tile: 'm4', from: 2, canGang: false, canPeng: true, chiOptions: canChi(tiles, 'm4', jokers), jokers,
    claimMeldProjection: projection, visibleTiles: [...tiles, 'm4'], wallCount: 25,
    ...(withBonus ? { patternBonus: (after: TileType[], melds: Meld[]) => {
      calls.push(structuredClone({ hand: after, melds })); return 0
    } } : {}) }
  const before = structuredClone({ hand: view.hand, melds: view.melds, chiOptions: view.chiOptions })
  const action = decideClaim(view)
  expect({ hand: view.hand, melds: view.melds, chiOptions: view.chiOptions }).toEqual(before)
  return { action, calls, view }
}

it('passes a physically consistent post-claim hand and independent peng/chi meld to every callback', () => {
  const { calls, view } = inspect()
  expect(calls[0]).toEqual({ hand, melds: [] }) // pass/baseline remains concealed
  expect(calls.length).toBeGreaterThan(2)
  const projected = calls.slice(1)
  expect(new Set(projected.map(c => c.melds[0].type))).toEqual(new Set(['peng','chi']))
  for (const call of projected) {
    expect(call.hand.length + call.melds.length * 3).toBe(13)
    expect(call.melds).toHaveLength(1)
    const meld = call.melds[0]
    expect(meld.from).toBe(2)
    expect(meld.tile).toBe('m4')
    if (meld.type === 'peng') expect(meld.tiles).toEqual(['m4','m4','m4'])
    else expect(view.chiOptions.map(option => option.tiles)).toContainEqual(meld.tiles)
  }
})

it('preserves existing concealed kongs while adding exactly one new meld', () => {
  const prior: Meld = { type: 'angang', tile: 's9', tiles: ['s9','s9','s9','s9'] }
  const { calls } = inspect([prior])
  for (const call of calls.slice(1)) {
    expect(call.melds).toHaveLength(2)
    expect(call.melds[0]).toEqual(prior)
    expect(call.hand.length + call.melds.length * 3).toBe(13)
  }
})

it('supports explicit old-projection rollback without changing non-bonus callers', () => {
  const old = inspect([], false)
  expect(old.calls.slice(1).every(c => c.hand.length === 10 && c.melds.length === 0)).toBe(true)
  expect(inspect([], false, false).action).toEqual(inspect([], true, false).action)
})

it('honors build rollback and leaves the unvalidated LLM policy opted out', () => {
  expect(BLOOD_FLOW_AI.claimMeldProjection).toBe(import.meta.env.VITE_BLOOD_FLOW_CLAIM_MELD_PROJECTION !== 'off')
  expect(BLOOD_FLOW_LLM_AI.claimMeldProjection).toBe(false)
})
