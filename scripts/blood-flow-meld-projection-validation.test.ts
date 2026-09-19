import { expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { newRound, nextSeatToAct, submit } from './blood-flow-counterfactual'
import { pairedContest } from './blood-flow-route-opportunity'
import { meldControl, meldFixed } from './blood-flow-meld-projection-policy'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'

it('reconstructs both recorded cases using the prior production policy', () => {
  const rows: unknown[] = []
  for (const seed of [1100001, 1100008]) {
    const engine = newRound(seed, ((seed - 1100001) % 4) as 0 | 1 | 2 | 3)
    let steps = 0, found = false
    while (!engine.result) {
      if (++steps > 2000) throw new Error('Case reconstruction stalled')
      const seat = nextSeatToAct(engine), view = bloodFlowSeatView(engine, seat), original = meldControl(view)!
      if (!found && original.kind === 'peng' && view.wallCount <= 40 && !view.public.seats[seat].locked
        && !view.ownActions.some(a => a.kind === 'win')) {
        found = true
        const fixed = meldFixed(view)
        expect(view.ownActions).toContainEqual(fixed)
        rows.push({ seed, seat, wallCount: view.wallCount, original, fixed })
      }
      submit(engine, seat, original)
    }
    expect(found).toBe(true)
  }
  mkdirSync('work/blood-flow-meld-projection', { recursive: true })
  writeFileSync('work/blood-flow-meld-projection/recorded-cases.json', JSON.stringify(rows, null, 2))
}, 120_000)

it('generic match control and prefix reuse agree exactly with full replay', () => {
  const fast = pairedContest(1200002, 4, true, meldFixed, meldControl)
  const full = pairedContest(1200002, 4, false, meldFixed, meldControl)
  expect(fast.rows.some(row => row.diverged)).toBe(true)
  expect(fast.rows).toEqual(full.rows)
  expect(fast.controlNet).toEqual(full.controlNet)
}, 240_000)

it('current-production A/A stays exactly zero in all four seats', () => {
  expect(pairedContest(1190002, 4, true, meldControl, meldControl).rows.map(row => row.deltaVsControl)).toEqual([0,0,0,0])
}, 120_000)
