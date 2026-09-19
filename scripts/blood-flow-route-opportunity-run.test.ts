import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG, BLOOD_FLOW_ACTION_PRIORITY } from '../src/game/variants/lotus/bloodFlow/config'
import { BASELINE_AI, clusterSummary, mean } from './blood-flow-counterfactual'
import { OPPORTUNITY_SPEC, pairedContest, type ContestRow } from './blood-flow-route-opportunity'

function fingerprint() {
  const files: string[] = []
  const visit = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (entry.name.endsWith('.ts')) files.push(path)
  } }
  visit('src/game')
  files.push('scripts/blood-flow-counterfactual.ts', 'scripts/blood-flow-route-opportunity.ts', 'scripts/blood-flow-route-opportunity-run.test.ts')
  const hash = createHash('sha256')
  for (const path of files.sort()) hash.update(path.replaceAll('\\', '/')).update('\0').update(readFileSync(path)).update('\0')
  return hash.digest('hex')
}
function integer(name: string, fallback: number, max: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`)
  return value
}
function summarize(rows: ContestRow[]) {
  const metric = (value: (row: ContestRow) => number) => clusterSummary(rows.map(r => ({ seed: r.seed, value: value(r) })))
  return { matches: rows.length, seeds: new Set(rows.map(r => r.seed)).size,
    netPerEastMatch: metric(r => r.net), pairedIncrementPerEastMatch: metric(r => r.deltaVsControl),
    pairedIncrementPerRound: metric(r => r.deltaVsControl / 4),
    firstPlaceRate: metric(r => Number(r.firstPlace)), meanRank: metric(r => r.rank),
    winsPerMatch: metric(r => r.wins), bigDiscardLossDelta: metric(r => r.bigDiscardLoss - r.controlBigDiscardLoss),
    divergedMatches: rows.filter(r => r.diverged).length,
    triggeredDecisions: rows.flatMap(r => r.gateEvents).length,
    changedDecisions: rows.flatMap(r => r.gateEvents).filter(e => e.changed).length,
    changedToWin: rows.flatMap(r => r.gateEvents).filter(e => e.changed && e.chosen.kind === 'win').length,
    firstWinWallMean: mean(rows.flatMap(r => r.firstWinWall).filter((x): x is number => x !== null)),
    // Exploratory diagnostic; primary endpoint includes all seeds, including zero intervention.
    changedSeatOutcomes: rows.filter(r => r.diverged).map(r => ({ seed: r.seed, seat: r.seat, delta: r.deltaVsControl })),
  }
}

it.skipIf(process.env.BF_OP_RUN !== '1')('evaluates opportunity guard in complete four-round East matches', () => {
  const seedFrom = integer('BF_OP_FROM', 980001, 500_000_000)
  const seeds = integer('BF_OP_SEEDS', 4, 10_000)
  const tag = process.env.BF_OP_TAG ?? 'pilot'
  if (!/^[a-zA-Z0-9_-]+$/.test(tag)) throw new Error('Unsafe tag')
  const dir = `work/blood-flow-route-opportunity/${tag}`
  if (existsSync(`${dir}/metadata.json`)) throw new Error('Use a fresh tag; existing evidence is never overwritten')
  mkdirSync(dir, { recursive: true })
  const started = Date.now(), sourceFingerprint = fingerprint()
  const metadata = { schema: 1, tag, seedFrom, seeds, roundsPerMatch: 4, candidateSeatsPerSeed: 4,
    spec: OPPORTUNITY_SPEC, startedAt: new Date(started).toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint,
    configHash: createHash('sha256').update(JSON.stringify([BLOOD_FLOW_CONFIG, BASELINE_AI, BLOOD_FLOW_ACTION_PRIORITY])).digest('hex'),
    ruleConfig: BLOOD_FLOW_CONFIG, aiConfig: BASELINE_AI, actionPriority: BLOOD_FLOW_ACTION_PRIORITY,
    apiRequests: 0, objective: 'Mean net points per candidate seat per four-round East match vs 3 unchanged baseline seats; scores carry between rounds.',
    pairing: 'Same four shuffled deals and dice per seed; candidate in seats 0,1,2,3 separately; all-baseline control. Independent source seeds are clusters.',
    optimization: 'Exact common-prefix reuse until first action divergence, verified against full replay. All future candidate decisions remain active.',
  }
  writeFileSync(`${dir}/metadata.json`, JSON.stringify(metadata, null, 2))
  const rows: ContestRow[] = []
  for (let seed = seedFrom; seed < seedFrom + seeds; seed++) {
    const result = pairedContest(seed)
    rows.push(...result.rows)
    writeFileSync(`${dir}/seed-${seed}.json`, JSON.stringify(result, null, 2))
    writeFileSync(`${dir}/progress.json`, JSON.stringify({ completedSeeds: seed - seedFrom + 1,
      candidateEastMatches: rows.length, elapsedSeconds: (Date.now() - started) / 1000,
      divergedMatches: rows.filter(r => r.diverged).length, changedDecisions: rows.flatMap(r => r.gateEvents).filter(e => e.changed).length }))
  }
  expect(fingerprint()).toBe(sourceFingerprint)
  const summary = { metadata, elapsedSeconds: (Date.now() - started) / 1000, summary: summarize(rows) }
  writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary.summary, null, 2))
}, 7_200_000)
