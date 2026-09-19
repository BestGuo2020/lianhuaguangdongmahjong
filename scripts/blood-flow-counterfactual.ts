/** Offline diagnostics only. Never imported by the game or used as a live policy. */
import { BloodFlowEngine } from '../src/game/variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView, type BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { bloodFlowAiActions, decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import { bloodFlowEvContext } from '../src/game/variants/lotus/bloodFlow/evContext'
import { BLOOD_FLOW_AI } from '../src/game/variants/lotus/bloodFlow/config'
import { seededRandom } from '../src/game/variants/lotus/bloodFlow/simulation'
import { SEATS, vector, type BloodFlowAction } from '../src/game/variants/lotus/bloodFlow/state'
import type { Seat } from '../src/game/variants/lotus/bloodFlow/types'

export type Policy = (view: BloodFlowSeatView) => BloodFlowAction | null
// Preserve the pre-integration control even after the production default changes.
export const BASELINE_AI = Object.freeze({ ...BLOOD_FLOW_AI, routeOpportunityGuard: false, claimMeldProjection: false })
export const baseline: Policy = view => decideBloodFlowActionEv(view, BASELINE_AI)
const actionKey = (action: BloodFlowAction) => JSON.stringify(action)

export function newRound(seed: number, dealer: Seat = 0) {
  return new BloodFlowEngine({ authorityEpoch: 'counterfactual', roundId: `seed-${seed}`,
    random: seededRandom(seed), dealer, now: () => 0, winBeatMs: 0, paced: false })
}

/** Copies all instance state, including Maps/private bookkeeping, without running a new deal.
 * Unpaced engine has no continuation closures. Fail closed if that assumption changes.
 * v8.serialize(snapshot) is used by the runner for exact offline checkpoint replay.
 */
export function snapshotEngine(engine: BloodFlowEngine): Record<string, unknown> {
  if (engine.options.paced || engine.transition || engine.paused || engine.interrupted) {
    throw new Error('Only active, synchronous engine checkpoints are supported')
  }
  const { options, ...fields } = engine
  const { random: _random, now: _now, ...serializableOptions } = options
  return structuredClone({ ...fields, options: { ...serializableOptions, paced: false, winBeatMs: 0 } })
}

export function restoreEngine(snapshot: Record<string, unknown>): BloodFlowEngine {
  const fields = structuredClone(snapshot)
  const engine = Object.assign(Object.create(BloodFlowEngine.prototype), fields) as BloodFlowEngine
  Object.assign(engine.options, { now: () => 0, random: () => { throw new Error('Unexpected random draw after checkpoint') } })
  engine.assertConservation()
  return engine
}

export function nextSeatToAct(engine: BloodFlowEngine): Seat {
  const window = engine.window
  const seat = window && SEATS.find(s => window.options[s].length && !window.decisions[s])
  if (seat == null) throw new Error('Unsettled engine has no pending actor')
  return seat
}

export function submit(engine: BloodFlowEngine, seat: Seat, action: BloodFlowAction) {
  if (!engine.submit(engine.command(seat, action))) throw new Error(`Rejected ${seat}: ${actionKey(action)}`)
}

export function finish(engine: BloodFlowEngine, policies: readonly Policy[] = SEATS.map(() => baseline)) {
  let commands = 0
  while (!engine.result) {
    if (++commands > 2000) throw new Error('Continuation did not settle')
    const seat = nextSeatToAct(engine)
    const view = bloodFlowSeatView(engine, seat)
    if (view.players.some(p => p.seat !== seat && p.hand.length)) throw new Error('Private opponent hand leaked to policy')
    const action = policies[seat](view)
    if (!action) throw new Error('Policy returned no action')
    submit(engine, seat, action)
  }
  engine.assertConservation()
  return { commands, net: vector(s => engine.players[s].score - engine.openingScores[s]) }
}

export interface Candidate { id: string; roles: string[]; action: BloodFlowAction; tile?: string; estimatedChain?: number; anyWait?: boolean }
export interface WindowPlan {
  seat: Seat
  windowId: string
  source: string
  wallCount: number
  stage: string
  hand: string[]
  jokers: string[]
  immediateTotal: number
  estimatedWinEv: number
  estimatedChain: number
  baselineId: string
  candidates: Candidate[]
}

/** Select alternatives BEFORE any continuation is inspected. No sampled-world winner selection.
 * Self-draw only: compare win, actual baseline, top two distinct ready-preserving reform tiles,
 * and the baseline's discard with win/pass removed. Duplicate physical tile choices are merged.
 */
export function planWindow(view: BloodFlowSeatView): WindowPlan | null {
  const seat = view.seat, player = view.players[seat]
  if (view.public.seats[seat].locked || view.window?.kind !== 'turn'
    || view.window.source.kind !== 'draw' || !view.ownActions.some(a => a.kind === 'win')) return null
  const choice = baseline(view)
  if (!choice) throw new Error('No baseline at first-win window')
  const ev = bloodFlowEvContext(view)
  const candidates: Candidate[] = [{ id: 'win', roles: ['win'], action: { kind: 'win' } }]
  const semanticKey = (action: BloodFlowAction) => action.kind === 'discard'
    ? `discard:${player.hand[action.index]}` : actionKey(action)
  const add = (id: string, action: BloodFlowAction, extra: Partial<Candidate> = {}) => {
    const existing = candidates.find(c => semanticKey(c.action) === semanticKey(action))
    if (existing) { existing.roles.push(id); Object.assign(existing, extra); return existing.id }
    candidates.push({ id, roles: [id], action, ...(action.kind === 'discard' ? { tile: player.hand[action.index] } : {}), ...extra })
    return id
  }
  const baselineId = add('baseline', choice)
  const allowed = bloodFlowAiActions(view)
  const usedTiles = new Set<string>()
  for (const reform of ev.reformCandidates) {
    if (usedTiles.size >= 2) break
    if (usedTiles.has(reform.tile) || !allowed.some(a => a.kind === 'discard' && a.index === reform.index)) continue
    usedTiles.add(reform.tile)
    add(`reform-${usedTiles.size}`, { kind: 'discard', index: reform.index },
      { estimatedChain: reform.ev, anyWait: reform.anyWait })
  }
  const discards = allowed.filter(a => a.kind === 'discard')
  if (discards.length) {
    const decline = baseline({ ...view, ownActions: discards, ownScore: null })
    if (decline) add('decline-discard', decline)
  }
  return { seat, windowId: view.window.id, source: view.ownScore!.source, wallCount: view.wallCount,
    stage: ev.floorStage, hand: [...player.hand], jokers: [...view.jokers], immediateTotal: ev.immediateTotal,
    estimatedWinEv: ev.winEv, estimatedChain: ev.chainAfterWin, baselineId, candidates }
}

export function permuteWall(engine: BloodFlowEngine, seed: number) {
  const random = seededRandom(seed)
  for (let i = engine.wall.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[engine.wall[i], engine.wall[j]] = [engine.wall[j], engine.wall[i]]
  }
  engine.assertConservation()
}

export interface Outcome {
  candidateId: string
  sample: number // -1 = original wall; >=0 = independently seeded permutation
  net: number // remaining net, relative to score AT the decision window
  grossWinIncome: number
  payments: number
  discardPayments: number
  kongNet: number
  wins: number
  commands: number
}

export function rollout(checkpoint: Record<string, unknown>, plan: Pick<WindowPlan, 'seat'>, candidate: Candidate,
  sample: number, wallSeed: number, policy: Policy = baseline): Outcome {
  const engine = restoreEngine(checkpoint)
  if (sample >= 0) permuteWall(engine, wallSeed)
  const before = engine.players[plan.seat].score, ledgerStart = engine.ledger.length
  submit(engine, plan.seat, candidate.action)
  const { commands } = finish(engine, SEATS.map(() => policy))
  let grossWinIncome = 0, payments = 0, discardPayments = 0, kongNet = 0, wins = 0
  for (const entry of engine.ledger.slice(ledgerStart)) {
    if (entry.kind === 'kong') { kongNet += entry.deltas[plan.seat]; continue }
    for (const record of entry.batch.winners) {
      const delta = record.deltas[plan.seat]
      if (delta > 0) grossWinIncome += delta
      if (delta < 0) payments -= delta
      if (delta < 0 && entry.batch.source.kind === 'discard' && entry.batch.source.seat === plan.seat) discardPayments -= delta
      if (record.winner === plan.seat) wins++
    }
  }
  const net = engine.players[plan.seat].score - before
  if (net !== grossWinIncome - payments + kongNet) throw new Error('Outcome ledger mismatch')
  return { candidateId: candidate.id, sample, net, grossWinIncome, payments, discardPayments, kongNet, wins, commands: commands + 1 }
}

export function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }

/** Seed-level cluster bootstrap: repeated walls/windows never count as independent games. */
export function clusterSummary(rows: { seed: number; value: number }[], bootstrapSeed = 912701) {
  const groups = new Map<number, number[]>()
  for (const row of rows) groups.set(row.seed, [...(groups.get(row.seed) ?? []), row.value])
  const clusters = [...groups.values()].map(values => mean(values)!)
  const average = mean(clusters)
  if (clusters.length < 2) return { clusters: clusters.length, observations: rows.length, mean: average, ci95: null }
  const random = seededRandom(bootstrapSeed), means: number[] = []
  for (let b = 0; b < 4000; b++) {
    let total = 0
    for (let i = 0; i < clusters.length; i++) total += clusters[Math.floor(random() * clusters.length)]
    means.push(total / clusters.length)
  }
  means.sort((a, b) => a - b)
  return { clusters: clusters.length, observations: rows.length, mean: average,
    ci95: [means[99], means[3899]], method: 'seed-cluster percentile bootstrap; equal weight per source seed' }
}

/** Head-to-head foundation. Same deal, candidate in each of four seats; pair vs baseline replay.
 * Call with a public-view-only candidate policy, never with sampled-world knowledge.
 */
export function pairedMatch(seed: number, candidate: Policy) {
  const control = finish(newRound(seed))
  return SEATS.map(seat => {
    const result = finish(newRound(seed), SEATS.map(s => s === seat ? candidate : baseline))
    return { seed, seat, net: result.net[seat], deltaVsControl: result.net[seat] - control.net[seat] }
  })
}
