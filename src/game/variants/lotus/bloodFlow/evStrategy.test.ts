import { expect, it } from 'vitest'
import type { Meld, TileType } from '../../../core/contracts/types'
import { BloodFlowEngine } from './engine'
import { bloodFlowSeatView } from './seatView'
import type { BloodFlowSeatView } from './seatView'
import { seededRandom } from './simulation'
import { decideBloodFlowActionEv } from './ai'
import { BLOOD_FLOW_AI } from './config'
import { SEATS } from './state'
import type { BloodFlowAction } from './state'
import type { SourceTileEvent, WinSource } from './types'

function view(overrides: {
  hand?: TileType[]; jokers?: TileType[]; melds?: Meld[]; wallCount?: number;
  drawnTileIndex?: number; locked?: boolean; ownActions?: BloodFlowAction[];
  ownScore?: { paymentPerPayer: number; source: WinSource } | null;
  windowKind?: 'turn' | 'win' | 'meld'; sourceKind?: SourceTileEvent['kind'];
} = {}): BloodFlowSeatView {
  const engine = new BloodFlowEngine({ authorityEpoch: 'ev', roundId: '1', random: seededRandom(5), now: () => 0 })
  const v = bloodFlowSeatView(engine, 0)
  const hand = overrides.hand ?? ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north']
  v.players[0].hand = [...hand]
  v.players[0].melds = overrides.melds ?? []
  v.players[0].drawnTileIndex = overrides.drawnTileIndex ?? hand.length - 1
  v.players[0].discards = []
  v.jokers = overrides.jokers ?? ['white']
  v.wallCount = overrides.wallCount ?? 60
  v.ownScore = (overrides.ownScore ?? null) as BloodFlowSeatView['ownScore']
  v.ownActions = overrides.ownActions ?? [
    { kind: 'win' }, { kind: 'pass' },
    ...hand.map((_, index) => ({ kind: 'discard', index }) as const),
  ]
  v.window = {
    id: 'w', version: 1,
    kind: overrides.windowKind ?? 'turn',
    deadlineAt: 0, opensAt: 0,
    source: { id: 's', kind: overrides.sourceKind ?? 'draw', tile: hand[hand.length - 1], seat: 0 },
  }
  if (overrides.locked) v.public = { ...v.public, seats: [{ ...v.public.seats[0], locked: true }, v.public.seats[1], v.public.seats[2], v.public.seats[3]] }
  return v
}

const CLEAN_MELDS: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p9', 'p9', 'p9']

it('locked hands keep full automation: win when possible, discard the drawn tile otherwise', () => {
  const withWin = view({ locked: true, ownActions: [{ kind: 'win' }, { kind: 'pass' }] })
  expect(decideBloodFlowActionEv(withWin, BLOOD_FLOW_AI)).toEqual({ kind: 'win' })
  const drawn = view({ locked: true, ownActions: [{ kind: 'discard', index: 13 }] })
  expect(decideBloodFlowActionEv(drawn, BLOOD_FLOW_AI)).toEqual({ kind: 'discard', index: 13 })
})

it('late game takes any win even with pattern potential', () => {
  const v = view({
    hand: [...CLEAN_MELDS, 's7', 'east'], drawnTileIndex: 13, wallCount: 8,
    ownScore: { paymentPerPayer: 10, source: 'self-draw' },
  })
  expect(decideBloodFlowActionEv(v, BLOOD_FLOW_AI)).toEqual({ kind: 'win' })
})

it('early game declines a cheap win when the hand has real pattern potential', () => {
  const v = view({
    hand: [...CLEAN_MELDS, 's7', 'east'], drawnTileIndex: 13, wallCount: 60,
    ownScore: { paymentPerPayer: 10, source: 'self-draw' },
  })
  const decision = decideBloodFlowActionEv(v, BLOOD_FLOW_AI)!
  expect(decision.kind).not.toBe('win')
  expect(v.ownActions).toContainEqual(decision)
})

it('drawing the joker reforms into a lone-joker any-tile wait instead of winning', () => {
  const v = view({
    hand: [...CLEAN_MELDS, 's7', 'white'], jokers: ['white'], drawnTileIndex: 13,
    ownScore: { paymentPerPayer: 20, source: 'self-draw' },
  })
  const decision = decideBloodFlowActionEv(v, BLOOD_FLOW_AI)!
  expect(decision).toEqual({ kind: 'discard', index: 12 })
})

it('takes a valuable robbed-kong win as the first win', () => {
  const v = view({
    ownActions: [{ kind: 'win' }, { kind: 'pass' }],
    windowKind: 'win', sourceKind: 'added-kong',
    ownScore: { paymentPerPayer: 40, source: 'robbed-kong' },
  })
  expect(decideBloodFlowActionEv(v, BLOOD_FLOW_AI)).toEqual({ kind: 'win' })
})

it('passes a cheap robbed-kong win to keep a near-big-pattern hand developing', () => {
  const nearBig: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3', 'm4', 'm4', 'm4', 'east']
  const v = view({
    hand: nearBig, jokers: [], ownActions: [{ kind: 'win' }, { kind: 'pass' }],
    windowKind: 'win', sourceKind: 'added-kong',
    ownScore: { paymentPerPayer: 20, source: 'robbed-kong' },
  })
  expect(decideBloodFlowActionEv(v, BLOOD_FLOW_AI)).toEqual({ kind: 'pass' })
})

it('declines a cheap discard win below the first-win floor to keep developing', () => {
  const nearBig: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3', 'm4', 'm4', 'm4', 'east']
  const v = view({
    hand: nearBig, jokers: [], ownActions: [{ kind: 'win' }, { kind: 'pass' }],
    windowKind: 'win', sourceKind: 'discard', wallCount: 60,
    ownScore: { paymentPerPayer: 10, source: 'discard' },
  })
  expect(decideBloodFlowActionEv(v, BLOOD_FLOW_AI)).toEqual({ kind: 'pass' })
})

it('keeps jokers protected while discarding with pattern guidance', () => {
  const v = view({ hand: [...CLEAN_MELDS, 's7', 'white'], jokers: ['white'], drawnTileIndex: 13 })
  v.ownActions = [...v.players[0].hand.map((_, index) => ({ kind: 'discard', index }) as const)]
  v.ownScore = null
  const decision = decideBloodFlowActionEv(v, BLOOD_FLOW_AI)!
  expect(decision.kind).toBe('discard')
  if (decision.kind === 'discard') expect(['white']).not.toContain(v.players[0].hand[decision.index])
  expect(v.ownActions).toContainEqual(decision)
})

it('completes fixed-seed rounds with the EV strategy, conserving tiles and scores', () => {
  let wins = 0
  for (let seed = 1; seed <= 8; seed++) {
    const engine = new BloodFlowEngine({ authorityEpoch: 'ev-rounds', roundId: `seed-${seed}`, random: seededRandom(seed), now: () => 0, winBeatMs: 0 })
    let steps = 0
    while (!engine.result) {
      if (++steps > 2000) throw new Error(`stalled seed ${seed}`)
      const window = engine.window!
      const seat = SEATS.find(s => window.options[s].length && !window.decisions[s])!
      const action = decideBloodFlowActionEv(bloodFlowSeatView(engine, seat), BLOOD_FLOW_AI)
      expect(action).toBeTruthy()
      expect(engine.submit(engine.command(seat, action!))).toBe(true)
      engine.assertConservation()
    }
    expect(engine.players.reduce((n, p) => n + p.score, 0)).toBe(8000)
    wins += engine.publicState().batches.flatMap(b => b.winners).length
  }
  expect(wins).toBeGreaterThan(0)
}, 240_000)
