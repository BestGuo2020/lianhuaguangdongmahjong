import { describe, expect, it } from 'vitest'
import { serialize, deserialize } from 'node:v8'
import { baseline, clusterSummary, finish, newRound, nextSeatToAct, pairedMatch, permuteWall,
  planWindow, restoreEngine, rollout, snapshotEngine, submit } from './blood-flow-counterfactual'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'

function firstWindow() {
  for (let seed = 940001; seed < 940021; seed++) {
    const engine = newRound(seed)
    for (let step = 0; !engine.result && step < 2000; step++) {
      const seat = nextSeatToAct(engine), view = bloodFlowSeatView(engine, seat)
      const plan = planWindow(view)
      if (plan && plan.candidates.length > 1) return { engine, plan }
      submit(engine, seat, baseline(view)!)
    }
  }
  throw new Error('Fixture seeds did not produce a first-win window')
}

describe('counterfactual evaluation invariants', () => {
  it('serialized fork continues exactly, including ledger, private evaluation and subsequent windows', () => {
    const { engine, plan } = firstWindow()
    const checkpoint = snapshotEngine(engine)
    const fork = restoreEngine(deserialize(serialize(checkpoint)))
    const scoreBefore = engine.players[plan.seat].score
    const result = rollout(checkpoint, plan, plan.candidates.find(c => c.id === plan.baselineId)!, -1, 0)
    finish(engine)
    finish(fork)
    expect(fork.result).toEqual(engine.result)
    expect(result.net).toBe(engine.players[plan.seat].score - scoreBefore)
    expect(restoreEngine(checkpoint).result).toBeNull()
    expect(restoreEngine(checkpoint).players[plan.seat].score).toBe(scoreBefore)
  }, 120_000)

  it('wall permutations preserve every seat observation and produce deterministic paired continuations', () => {
    const { engine, plan } = firstWindow()
    const checkpoint = snapshotEngine(engine), fork = restoreEngine(checkpoint)
    const views = [0, 1, 2, 3].map(seat => bloodFlowSeatView(engine, seat as 0 | 1 | 2 | 3))
    permuteWall(fork, 789)
    expect(fork.wall).not.toEqual(engine.wall)
    for (const seat of [0, 1, 2, 3] as const) expect(bloodFlowSeatView(fork, seat)).toEqual(views[seat])
    const win = plan.candidates[0]
    expect(rollout(checkpoint, plan, win, 0, 789)).toEqual(rollout(checkpoint, plan, win, 0, 789))
    expect(snapshotEngine(engine)).toEqual(checkpoint)
  }, 120_000)

  it('preselects legal, distinct actions using the seat view alone', () => {
    const { engine, plan } = firstWindow()
    const view = bloodFlowSeatView(engine, plan.seat)
    expect(view.players.filter(p => p.seat !== plan.seat).every(p => p.hand.length === 0)).toBe(true)
    for (const candidate of plan.candidates) expect(view.ownActions).toContainEqual(candidate.action)
    expect(plan.candidates.some(c => c.id === plan.baselineId && c.roles.includes('baseline'))).toBe(true)
    expect(planWindow({ ...view, public: { ...view.public,
      seats: view.public.seats.map((s, i) => i === plan.seat ? { ...s, locked: true } : s) as typeof view.public.seats } })).toBeNull()
  }, 120_000)

  it('rejects paced forks and does not count repeated observations as independent rounds', () => {
    const engine = newRound(123)
    Object.assign(engine.options, { paced: true })
    expect(() => snapshotEngine(engine)).toThrow('synchronous')
    const summary = clusterSummary([{ seed: 1, value: 10 }, { seed: 1, value: 10 }, { seed: 2, value: -10 }])
    expect(summary.clusters).toBe(2)
    expect(summary.mean).toBe(0)
    expect(clusterSummary([{ seed: 1, value: 10 }]).ci95).toBeNull()
  })

  it('identical-policy A/A is exactly zero after four-seat rotation and same-deal pairing', () => {
    const rows = pairedMatch(940002, baseline)
    expect(rows.map(r => r.deltaVsControl)).toEqual([0, 0, 0, 0])
    expect(rows.reduce((sum, r) => sum + r.net, 0)).toBe(0)
  }, 120_000)
})
