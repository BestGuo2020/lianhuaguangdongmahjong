import { expect, it } from 'vitest'
import { BloodFlowEngine } from './engine'
import { bloodFlowSeatView, visibleTiles } from './seatView'
import { decideBloodFlowAction } from './ai'
import { seededRandom } from './simulation'

it('projects only the viewer concealed hand and never exports wall order or scoring evidence', () => {
  const engine = new BloodFlowEngine({ authorityEpoch: 'privacy', roundId: '1', random: seededRandom(4), now: () => 0 })
  const view = bloodFlowSeatView(engine, 2)
  expect(view.players.map(p => p.hand.length)).toEqual([0, 0, 13, 0])
  expect(view.players[0].concealedTileCount).toBe(14)
  expect(view).not.toHaveProperty('wall')
  expect(view).not.toHaveProperty('flipTiles')
  expect(view).not.toHaveProperty('privateEvidence')
  expect(visibleTiles(view)).toEqual([engine.flipTiles[0], ...engine.players[2].hand])
  expect(() => bloodFlowSeatView(engine, 9 as any)).toThrow('Invalid viewer')
})

it('AI takes only an offered action and supports configurable first-win refusal', () => {
  const engine = new BloodFlowEngine({ authorityEpoch: 'ai', roundId: '1', random: seededRandom(3), now: () => 0 })
  const view = bloodFlowSeatView(engine, 0)
  const action = decideBloodFlowAction(view)
  expect(view.ownActions).toContainEqual(action)
  view.ownActions = [{ kind: 'win' }, { kind: 'pass' }]
  view.ownScore = { paymentPerPayer: 20 } as any
  expect(decideBloodFlowAction(view, 40)).toEqual({ kind: 'pass' })
  view.public = { ...view.public, seats: [{ ...view.public.seats[0], locked: true }, view.public.seats[1], view.public.seats[2], view.public.seats[3]] }
  expect(decideBloodFlowAction(view, 40)).toEqual({ kind: 'win' })
})
