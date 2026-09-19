/** Explicit opt-in, zero API, bounded offline run. See the adjacent report for the protocol. */
import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serialize } from 'node:v8'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG, BLOOD_FLOW_ACTION_PRIORITY } from '../src/game/variants/lotus/bloodFlow/config'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { BASELINE_AI, baseline, clusterSummary, mean, newRound, nextSeatToAct, planWindow, rollout, snapshotEngine,
  submit, type Outcome, type WindowPlan } from './blood-flow-counterfactual'

interface RecordRow { seed: number; step: number; plan: WindowPlan; outcomes: Outcome[]; originalBaselineRemaining: number }

function integer(name: string, fallback: number, max: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`)
  return value
}
function sourceFingerprint() {
  const files: string[] = []
  const visit = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (entry.name.endsWith('.ts')) files.push(path)
  } }
  visit('src/game')
  files.push('scripts/blood-flow-counterfactual.ts', 'scripts/blood-flow-counterfactual-run.test.ts')
  const hash = createHash('sha256')
  for (const path of files.sort()) hash.update(path.replaceAll('\\', '/')).update('\0').update(readFileSync(path)).update('\0')
  return hash.digest('hex')
}

function summarize(records: RecordRow[]) {
  const summarizeDifference = (role: string, reference: string, filter: (row: RecordRow) => boolean = () => true) => {
    const rows: { seed: number; value: number }[] = []
    for (const record of records.filter(filter)) {
      const candidate = record.plan.candidates.find(c => c.roles.includes(role))
      const control = record.plan.candidates.find(c => c.roles.includes(reference))
      if (!candidate || !control) continue
      const deltas = record.outcomes.filter(o => o.sample >= 0 && o.candidateId === candidate.id).map(o =>
        o.net - record.outcomes.find(c => c.sample === o.sample && c.candidateId === control.id)!.net)
      rows.push({ seed: record.seed, value: mean(deltas)! })
    }
    return clusterSummary(rows)
  }
  const calibration = records.map(record => {
    const wins = record.outcomes.filter(o => o.sample >= 0 && o.candidateId === 'win')
    return { seed: record.seed, estimated: record.plan.estimatedChain,
      realized: mean(wins.map(o => o.grossWinIncome - record.plan.immediateTotal))! }
  })
  return {
    windows: records.length,
    sourceSeedsWithWindows: new Set(records.map(r => r.seed)).size,
    baselineDeclines: records.filter(r => r.plan.baselineId !== 'win').length,
    stages: Object.fromEntries(['early', 'mid', 'late'].map(stage => [stage, records.filter(r => r.plan.stage === stage).length])),
    winMinusBaseline: summarizeDifference('win', 'baseline'),
    winMinusBaselineWhenDeclined: summarizeDifference('win', 'baseline', r => r.plan.baselineId !== 'win'),
    reform1MinusWin: summarizeDifference('reform-1', 'win'),
    reform2MinusWin: summarizeDifference('reform-2', 'win'),
    discardMinusWin: summarizeDifference('decline-discard', 'win'),
    reform1MinusWinWhenBaselineWins: summarizeDifference('reform-1', 'win', r => r.plan.baselineId === 'win'),
    calibration: {
      estimatedChainMean: mean(calibration.map(r => r.estimated)),
      realizedRemainingGrossWinIncomeMean: mean(calibration.map(r => r.realized)),
      estimateMinusRealized: clusterSummary(calibration.map(r => ({ seed: r.seed, value: r.estimated - r.realized }))),
      caveat: 'Full remaining round gross income; chain estimate has a finite horizon. Not an exact same-target calibration.'
    },
    rollouts: records.reduce((sum, r) => sum + r.outcomes.length, 0),
  }
}

it.skipIf(process.env.BF_CF_RUN !== '1')('runs first-self-draw-win counterfactuals', () => {
  const seedFrom = integer('BF_CF_FROM', 950001, 2_000_000_000)
  const rounds = integer('BF_CF_ROUNDS', 2, 10_000)
  const samples = integer('BF_CF_SAMPLES', 2, 1024)
  const tag = process.env.BF_CF_TAG ?? 'smoke'
  if (!/^[a-zA-Z0-9_-]+$/.test(tag)) throw new Error('Unsafe tag')
  const dir = `work/blood-flow-counterfactual/${tag}`
  mkdirSync(dir, { recursive: true })
  const started = Date.now(), fingerprint = sourceFingerprint()
  const metadata = {
    schema: 1, tag, seedFrom, rounds, samples, startedAt: new Date(started).toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: fingerprint,
    configHash: createHash('sha256').update(JSON.stringify([BLOOD_FLOW_CONFIG, BASELINE_AI, BLOOD_FLOW_ACTION_PRIORITY])).digest('hex'),
    ruleConfig: BLOOD_FLOW_CONFIG, aiConfig: BASELINE_AI, actionPriority: BLOOD_FLOW_ACTION_PRIORITY,
    apiRequests: 0, sampling: 'First unlocked self-draw win window per seat per baseline round; all four seats; dealer rotates by seed offset.',
    uncertainty: 'Conditional on actual concealed opponent hands AND remaining tile inventory. Only wall order is permuted; not a public-information posterior.',
    policies: 'One forced action, then unchanged local EV for all seats until settlement. Candidate roles are preselected using only seat view.',
    interval: 'Seed-cluster bootstrap over mean paired permutation deltas; original wall excluded from inference. Exploratory, not multiplicity-adjusted.',
  }
  writeFileSync(`${dir}/metadata.json`, JSON.stringify(metadata, null, 2))
  const all: RecordRow[] = []
  for (let seed = seedFrom; seed < seedFrom + rounds; seed++) {
    const engine = newRound(seed, ((seed - seedFrom) % 4) as 0 | 1 | 2 | 3)
    const seenSeats = new Set<number>(), collected: { record: RecordRow; scoreBefore: number }[] = []
    let step = 0
    while (!engine.result) {
      if (++step > 2000) throw new Error(`Stalled source seed ${seed}`)
      const seat = nextSeatToAct(engine), view = bloodFlowSeatView(engine, seat)
      const action = baseline(view)
      if (!action) throw new Error('Source policy returned no action')
      const plan = seenSeats.has(seat) ? null : planWindow(view)
      if (plan) {
        seenSeats.add(seat)
        const checkpoint = snapshotEngine(engine)
        writeFileSync(`${dir}/window-${seed}-${seat}.bin`, serialize({ checkpoint, plan }))
        const outcomes: Outcome[] = []
        for (let sample = -1; sample < samples; sample++) {
          const wallSeed = ((seed * 2654435761) ^ (seat * 2246822519) ^ ((sample + 2) * 3266489917)) >>> 0
          for (const candidate of plan.candidates) outcomes.push(rollout(checkpoint, plan, candidate, sample, wallSeed))
        }
        collected.push({ record: { seed, step, plan, outcomes, originalBaselineRemaining: 0 }, scoreBefore: engine.players[seat].score })
      }
      submit(engine, seat, action)
    }
    for (const { record, scoreBefore } of collected) {
      record.originalBaselineRemaining = engine.players[record.plan.seat].score - scoreBefore
      expect(record.outcomes.find(o => o.sample === -1 && o.candidateId === record.plan.baselineId)!.net).toBe(record.originalBaselineRemaining)
      all.push(record)
    }
    writeFileSync(`${dir}/seed-${seed}.json`, JSON.stringify(collected.map(c => c.record), null, 2))
    writeFileSync(`${dir}/progress.json`, JSON.stringify({ completedRounds: seed - seedFrom + 1, windows: all.length,
      elapsedSeconds: (Date.now() - started) / 1000, rollouts: all.reduce((n, r) => n + r.outcomes.length, 0) }))
  }
  expect(sourceFingerprint()).toBe(fingerprint)
  const report = { metadata, elapsedSeconds: (Date.now() - started) / 1000, summary: summarize(all) }
  writeFileSync(`${dir}/summary.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ tag, ...report.summary, elapsedSeconds: report.elapsedSeconds }, null, 2))
}, 7_200_000)
