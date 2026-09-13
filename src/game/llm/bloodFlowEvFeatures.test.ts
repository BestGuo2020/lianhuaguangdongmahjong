import { expect, it } from 'vitest'
import type { Meld, TileType } from '../core/contracts/types'
import { BloodFlowEngine } from '../variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import type { BloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import { seededRandom } from '../variants/lotus/bloodFlow/simulation'
import { BLOOD_FLOW_AI } from '../variants/lotus/bloodFlow/config'
import type { BloodFlowAction } from '../variants/lotus/bloodFlow/state'
import type { SourceTileEvent, WinSource } from '../variants/lotus/bloodFlow/types'
import { buildBloodFlowDecisionInput } from './bloodFlowDecisionInput'
import { bloodFlowDecisionPrompt } from './bloodFlowRuntime'

function view(overrides: {
  hand?: TileType[]; jokers?: TileType[]; melds?: Meld[]; wallCount?: number;
  drawnTileIndex?: number; locked?: boolean; ownActions?: BloodFlowAction[];
  ownScore?: { paymentPerPayer: number; source: WinSource } | null;
  windowKind?: 'turn' | 'win' | 'meld'; sourceKind?: SourceTileEvent['kind'];
} = {}): BloodFlowSeatView {
  const engine = new BloodFlowEngine({ authorityEpoch: 'ev-llm', roundId: '1', random: seededRandom(5), now: () => 0 })
  const v = bloodFlowSeatView(engine, 0)
  const hand = overrides.hand ?? ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north']
  v.players[0].hand = [...hand]
  v.players[0].melds = overrides.melds ?? []
  v.players[0].drawnTileIndex = overrides.drawnTileIndex ?? hand.length - 1
  v.players[0].discards = []
  v.jokers = overrides.jokers ?? ['white']
  v.wallCount = overrides.wallCount ?? 60
  v.ownScore = (overrides.ownScore ? { items: [], ...overrides.ownScore } : null) as unknown as BloodFlowSeatView['ownScore']
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

const CLEAN_MELDS: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p1', 'p1']

it('injects the any-tile reform EV into the self-draw discard candidate and suggests it', () => {
  const v = view({
    hand: [...CLEAN_MELDS, 's7', 'white'], jokers: ['white'], drawnTileIndex: 13,
    ownScore: { paymentPerPayer: 20, source: 'self-draw' },
  })
  const built = buildBloodFlowDecisionInput(v, 'reform')
  const reformCandidate = built.candidates.find(c => c.action.kind === 'discard' && c.action.index === 12)!
  expect(reformCandidate.features.ev?.reform).toMatchObject({ anyWait: true, waitCount: 34 })
  expect(reformCandidate.features.ev!.reform!.chain).toBeGreaterThan(0)
  expect(built.request?.engineSuggestion).toBe(reformCandidate.id)
  expect(reformCandidate.summary).toContain('任意听')

  const prompt = bloodFlowDecisionPrompt(v, [], 'reform')
  expect(prompt.messages.system).toContain('可以覆盖')
  const payload = JSON.parse(prompt.messages.user)
  const injected = payload.candidates.find((c: { id: string }) => c.id === reformCandidate.id)
  expect(injected.features.ev.reform.anyWait).toBe(true)
  expect(payload.ruleSummary).toContain('期望收益')
})

it('injects robbed-kong win/pass EV on both options and suggests the greedy side', () => {
  const nearBig: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3', 'm4', 'm4', 'm4', 'east']
  const v = view({
    hand: nearBig, jokers: [], ownActions: [{ kind: 'win' }, { kind: 'pass' }],
    windowKind: 'win', sourceKind: 'added-kong',
    ownScore: { paymentPerPayer: 20, source: 'robbed-kong' },
  })
  const built = buildBloodFlowDecisionInput(v, 'rob')
  const winCandidate = built.candidates.find(c => c.action.kind === 'win')!
  const passCandidate = built.candidates.find(c => c.action.kind === 'pass')!
  expect(winCandidate.features.ev?.rob).toBeDefined()
  expect(passCandidate.features.ev?.rob).toEqual(winCandidate.features.ev?.rob)
  const rob = winCandidate.features.ev!.rob!
  expect(rob.passEv).toBeGreaterThan(rob.winEv)
  expect(built.request?.engineSuggestion).toBe(passCandidate.id)
  expect(passCandidate.summary).toContain('抢杠期望')
})

it('marks an early cheap win below the floor with the decline reason and suggests declining', () => {
  const v = view({
    hand: [...CLEAN_MELDS, 's7', 'east'], drawnTileIndex: 13, wallCount: 60,
    ownScore: { paymentPerPayer: 10, source: 'self-draw' },
  })
  const built = buildBloodFlowDecisionInput(v, 'decline')
  const winCandidate = built.candidates.find(c => c.action.kind === 'win')!
  expect(winCandidate.features.ev?.win).toMatchObject({ immediateTotal: 30, floor: 40, floorStage: 'early' })
  expect(winCandidate.features.ev!.win!.declinedReason).toContain('清一色')
  expect(built.request?.engineSuggestion).not.toBe(winCandidate.id)
  expect(winCandidate.summary).toContain('首胡门槛')
})

it('falls back to the legacy prompt and suggestion when llmEvFeatures is disabled', () => {
  const v = view({
    hand: [...CLEAN_MELDS, 's7', 'east'], drawnTileIndex: 13, wallCount: 60,
    ownScore: { paymentPerPayer: 10, source: 'self-draw' },
  })
  const built = buildBloodFlowDecisionInput(v, 'off', {}, { ...BLOOD_FLOW_AI, llmEvFeatures: false })
  expect(built.candidates.every(c => !c.features.ev)).toBe(true)
  const winCandidate = built.candidates.find(c => c.action.kind === 'win')!
  expect(built.request?.engineSuggestion).toBe(winCandidate.id)
})

it('leaves locked and no-win windows untouched by the EV injection', () => {
  const v = view({ locked: true, ownActions: [{ kind: 'discard', index: 13 }] })
  const built = buildBloodFlowDecisionInput(v, 'locked')
  expect(built.candidates.every(c => !c.features.ev)).toBe(true)
})

it('injects the kong value breakdown and declines a kong that would break the seven-pairs route', () => {
  const hand: TileType[] = ['m3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 's3', 's3', 'p7', 's8']
  const v = view({
    hand, jokers: ['red'], drawnTileIndex: -1,
    ownActions: [{ kind: 'pass' }, { kind: 'gang' }, { kind: 'peng' }],
    windowKind: 'meld', sourceKind: 'discard',
  })
  v.window = { ...v.window!, source: { id: 's', kind: 'discard', tile: 'm3', seat: 3 } }
  const built = buildBloodFlowDecisionInput(v, 'kong-value')
  const gang = built.candidates.find(c => c.action.kind === 'gang')!
  const kong = gang.features.kongValue!
  expect(kong.net).toBeLessThan(0)
  expect(kong.selfLoss.sevenPairs).toBeGreaterThan(kong.gain)
  expect(kong.reasons?.join()).toContain('七对')
  expect(gang.summary).toContain('开杠价值')
  expect(built.request?.engineSuggestion).toBe(built.candidates.find(c => c.action.kind === 'pass')!.id)

  const prompt = bloodFlowDecisionPrompt(v, [], 'kong-value')
  const payload = JSON.parse(prompt.messages.user)
  const injected = payload.candidates.find((c: { id: string }) => c.id === gang.id)
  expect(injected.features.kongValue.net).toBe(kong.net)
  expect(payload.ruleSummary).toContain('features.kongValue')
})

it('still offers the kong when the route is dead (kong value stays positive)', () => {
  const hand: TileType[] = ['m5', 'm5', 'm5', 'm1', 'm1', 'm2', 'm2', 'p4', 'p5', 'p6', 's7', 's9', 'east']
  const v = view({
    hand, jokers: ['red'], drawnTileIndex: -1,
    ownActions: [{ kind: 'pass' }, { kind: 'gang' }, { kind: 'peng' }],
    windowKind: 'meld', sourceKind: 'discard',
  })
  v.window = { ...v.window!, source: { id: 's', kind: 'discard', tile: 'm5', seat: 3 } }
  const built = buildBloodFlowDecisionInput(v, 'kong-value-dead')
  const gang = built.candidates.find(c => c.action.kind === 'gang')!
  expect(gang.features.kongValue!.selfLoss.sevenPairs).toBe(0)
  expect(gang.features.kongValue!.net).toBeGreaterThan(0)
  expect(built.request?.engineSuggestion).toBe(gang.id)
})
