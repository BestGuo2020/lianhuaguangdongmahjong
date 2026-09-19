/** Experimental public-information policy. No production imports this module. */
import { BloodFlowEngine } from '../src/game/variants/lotus/bloodFlow/engine'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG } from '../src/game/variants/lotus/bloodFlow/config'
import { bloodFlowAiActions, decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import { narrowActionsToRoute } from '../src/game/variants/lotus/bloodFlow/bigHandRoute'
import { bloodFlowSeatView, type BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { seededRandom } from '../src/game/variants/lotus/bloodFlow/simulation'
import { SEATS, vector, type BloodFlowAction } from '../src/game/variants/lotus/bloodFlow/state'
import type { Seat } from '../src/game/variants/lotus/bloodFlow/types'
import { baseline, mean, nextSeatToAct, restoreEngine, snapshotEngine, submit, type Policy } from './blood-flow-counterfactual'

export const OPPORTUNITY_SPEC = Object.freeze({
  id: 'first-self-draw-no-deficit-wall-bypass-v1',
  scope: 'Unlocked self-draw win windows only, including kong bloom. No changes to external wins or locked seats.',
  opportunityProxy: 'Require existing route minWallForCommit / minWallForCommitWithJokers even when behind.',
  intervention: 'When only the deficit exception lets a route remove win, disable route narrowing for this decision; original EV still chooses win/reform/kong.',
  minWall: BLOOD_FLOW_AI.bigHandRoute.minWallForCommit,
  minWallWithJokers: BLOOD_FLOW_AI.bigHandRoute.minWallForCommitWithJokers,
  jokerReliefCount: BLOOD_FLOW_AI.bigHandRoute.jokerReliefCount,
  notClaimed: 'Wall length is an opportunity proxy, not a calibrated completion probability or a proof a route is impossible.',
})

export interface OpportunityGate { route: string; wallCount: number; wallFloor: number; deficit: number; heldJokers: number }

export function opportunityGate(view: BloodFlowSeatView): OpportunityGate | null {
  const config = BLOOD_FLOW_AI.bigHandRoute
  if ((config.mode !== 'bot' && config.mode !== 'all') || view.public.seats[view.seat].locked
    || view.window?.kind !== 'turn' || view.window.source.kind !== 'draw'
    || !view.ownActions.some(a => a.kind === 'win')) return null
  const player = view.players[view.seat]
  const heldJokers = player.hand.filter(tile => tile === 'white' || view.jokers.includes(tile)).length
  const wallFloor = heldJokers >= config.jokerReliefCount ? config.minWallForCommitWithJokers : config.minWallForCommit
  if (view.wallCount >= wallFloor) return null
  const deficit = Math.max(...view.players.filter(p => p.seat !== view.seat).map(p => p.score)) - player.score
  if (deficit < config.minDeficitForCommit) return null
  const actions = bloodFlowAiActions(view)
  // Do not undo kong-priority or any other non-route policy restriction.
  if (!actions.some(a => a.kind === 'win')) return null
  const route = narrowActionsToRoute(player.hand, player.melds, view.jokers, actions, {
    config, basePoints: BLOOD_FLOW_CONFIG.basePoints, immediateWinPayment: view.ownScore?.paymentPerPayer ?? 0,
    wallCount: view.wallCount, scoreDeficit: deficit,
  })
  if (!route.collapsed || !route.route || route.actions.some(a => a.kind === 'win')) return null
  return { route: route.route.id, wallCount: view.wallCount, wallFloor, deficit, heldJokers }
}

const routeOffConfig = Object.freeze({ ...BLOOD_FLOW_AI,
  bigHandRoute: Object.freeze({ ...BLOOD_FLOW_AI.bigHandRoute, mode: 'off' as const }) })

export function opportunityDecision(view: BloodFlowSeatView, original?: BloodFlowAction | null) {
  const gate = opportunityGate(view)
  const action = gate ? decideBloodFlowActionEv(view, routeOffConfig) : original ?? baseline(view)
  return { action, gate }
}
export const opportunityPolicy: Policy = view => opportunityDecision(view).action
export const sameAction = (a: BloodFlowAction | null, b: BloodFlowAction | null) => JSON.stringify(a) === JSON.stringify(b)

function matchRound(seed: number, round: number, scores: readonly [number, number, number, number]) {
  return new BloodFlowEngine({ authorityEpoch: 'opportunity-match', roundId: `match-${seed}-round-${round}`,
    random: seededRandom((Math.imul(seed, 4) + round) >>> 0), dealer: (round % 4) as Seat, scores,
    now: () => 0, winBeatMs: 0, paced: false })
}

interface RoundMetrics {
  net: number[]; wins: number[]; bigDiscardLoss: number[]; firstWinWall: (number | null)[]
}
export interface GateEvent extends OpportunityGate {
  round: number; windowId: string; original: BloodFlowAction; chosen: BloodFlowAction; changed: boolean
}
interface Fork { round: number; checkpoint: Record<string, unknown>; event: GateEvent }
export interface ContestRow {
  seed: number; seat: Seat; net: number; deltaVsControl: number; firstPlace: boolean; rank: number
  roundNet: number[]; wins: number; bigDiscardLoss: number; controlBigDiscardLoss: number
  firstWinWall: (number | null)[]; gateEvents: GateEvent[]; diverged: boolean
}

function metrics(engine: BloodFlowEngine): RoundMetrics {
  if (!engine.result) throw new Error('Metrics require a settled round')
  const firstWinWall: (number | null)[] = SEATS.map(() => null)
  // First-win wall is collected during play below; ledger alone cannot reconstruct wall advances.
  const bigDiscardLoss = vector(() => 0)
  for (const entry of engine.ledger) {
    if (entry.kind !== 'win' || entry.batch.source.kind !== 'discard') continue
    const payer = entry.batch.source.seat
    const loss = -entry.batch.deltas[payer]
    if (loss >= 160) bigDiscardLoss[payer] += loss
  }
  return { net: engine.result.endingScores.map((score, seat) => score - engine.openingScores[seat]),
    wins: [...engine.result.winCounts], bigDiscardLoss, firstWinWall }
}

/** Complete four-round East matches. Candidate rotates through all seats vs three baseline seats.
 * Reuses ONLY the common deterministic prefix before each focal seat's first action difference.
 * After divergence the candidate runs at EVERY future decision, with scores carried across rounds.
 * No hidden state reaches either policy. No counterfactual wall sampling or per-window oracle.
 */
export function pairedContest(seed: number, rounds = 4, optimized = true, candidate: Policy = opportunityPolicy) {
  const initial = vector(() => BLOOD_FLOW_CONFIG.initialScore)
  let scores = initial
  const forks = new Map<Seat, Fork>(), baselineMetrics: RoundMetrics[] = []
  const controlGateEvents = vector<GateEvent[]>(() => [])
  let actualCommands = 0
  const observeFirstWins = (engine: BloodFlowEngine, before: number[], beforeWall: number, first: (number | null)[]) => {
    for (const seat of SEATS) if (before[seat] === 0 && engine.seats[seat].winCount > 0 && first[seat] === null) first[seat] = beforeWall
  }
  for (let round = 0; round < rounds; round++) {
    const engine = matchRound(seed, round, scores), first: (number | null)[] = SEATS.map(() => null)
    let steps = 0
    while (!engine.result) {
      if (++steps > 2000) throw new Error('Control stalled')
      const seat = nextSeatToAct(engine), view = bloodFlowSeatView(engine, seat), original = baseline(view)
      if (!original) throw new Error('Control has no action')
      if (optimized && !forks.has(seat)) {
        const gate = opportunityGate(view)
        // Fast path is safe for this registered policy, or the exact baseline A/A policy.
        const chosen = candidate === opportunityPolicy ? (gate ? opportunityDecision(view, original).action : original) : candidate(view)
        if (!chosen) throw new Error('Candidate has no action')
        const event: GateEvent = { ...(gate ?? { route: 'other-policy', wallCount: view.wallCount, wallFloor: 0, deficit: 0, heldJokers: 0 }),
          round, windowId: view.window!.id, original, chosen, changed: !sameAction(original, chosen) }
        if (gate) controlGateEvents[seat].push(event)
        if (event.changed) forks.set(seat, { round, checkpoint: snapshotEngine(engine), event })
      }
      const before = engine.seats.map(s => s.winCount), beforeWall = engine.wall.length
      submit(engine, seat, original); actualCommands++
      observeFirstWins(engine, before, beforeWall, first)
    }
    scores = vector(s => engine.players[s].score)
    baselineMetrics.push({ ...metrics(engine), firstWinWall: first })
  }
  const controlNet = scores.map((score, seat) => score - initial[seat])
  const rows: ContestRow[] = []
  for (const focal of SEATS) {
    const fork = forks.get(focal)
    let diverged = Boolean(fork)
    let candidateScores = initial
    const candidateMetrics: RoundMetrics[] = [], events: GateEvent[] = []
    if (optimized && !fork) {
      candidateScores = scores
      candidateMetrics.push(...baselineMetrics)
      events.push(...controlGateEvents[focal])
    } else {
      const startRound = optimized ? fork!.round : 0
      if (optimized) {
        candidateMetrics.push(...baselineMetrics.slice(0, startRound))
        events.push(...controlGateEvents[focal].filter(e => e !== fork!.event && e.windowId !== fork!.event.windowId))
      }
      for (let round = startRound; round < rounds; round++) {
        const engine = optimized && round === startRound ? restoreEngine(fork!.checkpoint) : matchRound(seed, round, candidateScores)
        const first: (number | null)[] = optimized && round === startRound
          ? baselineMetrics[round].firstWinWall.map((wall, seat) => engine.seats[seat].winCount > 0 ? wall : null)
          : SEATS.map(() => null)
        let steps = 0
        while (!engine.result) {
          if (++steps > 2000) throw new Error('Candidate stalled')
          const seat = nextSeatToAct(engine), view = bloodFlowSeatView(engine, seat)
          if (view.players.some(p => p.seat !== seat && p.hand.length)) throw new Error('Hidden hand leaked')
          const original = baseline(view)
          if (!original) throw new Error('No baseline action')
          let chosen = original
          if (seat === focal) {
            const gate = opportunityGate(view)
            chosen = candidate === opportunityPolicy ? (gate ? opportunityDecision(view, original).action! : original) : candidate(view)!
            if (!chosen) throw new Error('No candidate action')
            if (!sameAction(original, chosen)) diverged = true
            if (gate) events.push({ ...gate, round, windowId: view.window!.id, original, chosen, changed: !sameAction(original, chosen) })
          }
          const before = engine.seats.map(s => s.winCount), beforeWall = engine.wall.length
          submit(engine, seat, chosen); actualCommands++
          observeFirstWins(engine, before, beforeWall, first)
        }
        candidateScores = vector(s => engine.players[s].score)
        candidateMetrics.push({ ...metrics(engine), firstWinWall: first })
      }
    }
    const net = candidateScores[focal] - initial[focal]
    const rank = 1 + candidateScores.filter(score => score > candidateScores[focal]).length
    rows.push({ seed, seat: focal, net, deltaVsControl: net - controlNet[focal], firstPlace: rank === 1, rank,
      roundNet: candidateMetrics.map(m => m.net[focal]), wins: candidateMetrics.reduce((n, m) => n + m.wins[focal], 0),
      bigDiscardLoss: candidateMetrics.reduce((n, m) => n + m.bigDiscardLoss[focal], 0),
      controlBigDiscardLoss: baselineMetrics.reduce((n, m) => n + m.bigDiscardLoss[focal], 0),
      firstWinWall: candidateMetrics.map(m => m.firstWinWall[focal]), gateEvents: events,
      diverged })
  }
  // Seat rotation of a zero-sum all-baseline control makes mean net == mean paired increment.
  if (Math.abs(mean(rows.map(r => r.net))! - mean(rows.map(r => r.deltaVsControl))!) > 1e-9) throw new Error('Paired accounting mismatch')
  return { seed, rounds, rows, controlNet, actualCommands }
}
