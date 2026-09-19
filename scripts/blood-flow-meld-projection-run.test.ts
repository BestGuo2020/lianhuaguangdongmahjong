import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_ACTION_PRIORITY } from '../src/game/variants/lotus/bloodFlow/config'
import { clusterSummary } from './blood-flow-counterfactual'
import { pairedContest, type ContestRow } from './blood-flow-route-opportunity'
import { meldControl, meldFixed, MELD_CONTROL_CONFIG, MELD_FIXED_CONFIG } from './blood-flow-meld-projection-policy'

function fingerprint() {
  const files: string[] = []
  const visit = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) visit(path)
    else if (item.name.endsWith('.ts')) files.push(path)
  } }
  visit('src/game')
  files.push(...['counterfactual', 'route-opportunity', 'meld-projection-policy', 'meld-projection-run.test'].map(s => `scripts/blood-flow-${s}.ts`))
  const hash = createHash('sha256')
  for (const path of files.sort()) hash.update(path.replaceAll('\\', '/')).update('\0').update(readFileSync(path)).update('\0')
  return hash.digest('hex')
}
function summary(rows: ContestRow[]) {
  const metric = (f: (row: ContestRow) => number) => clusterSummary(rows.map(r => ({ seed: r.seed, value: f(r) })))
  return { matches: rows.length, primary: metric(r => r.deltaVsControl), perRound: metric(r => r.deltaVsControl / 4),
    net: metric(r => r.net), firstPlace: metric(r => Number(r.firstPlace)), rank: metric(r => r.rank),
    bigDiscardLossDelta: metric(r => r.bigDiscardLoss - r.controlBigDiscardLoss),
    changedMatches: rows.filter(r => r.diverged).length,
    positiveMatches: rows.filter(r => r.deltaVsControl > 0).length, negativeMatches: rows.filter(r => r.deltaVsControl < 0).length,
    changes: rows.flatMap(r => r.decisionChanges),
    worst: [...rows].sort((a,b) => a.deltaVsControl - b.deltaVsControl).slice(0,5).map(r => ({ seed:r.seed, seat:r.seat, delta:r.deltaVsControl })),
    best: [...rows].sort((a,b) => b.deltaVsControl - a.deltaVsControl).slice(0,5).map(r => ({ seed:r.seed, seat:r.seat, delta:r.deltaVsControl })) }
}

it.skipIf(process.env.BF_MP_RUN !== '1')('compares the corrected projection with current production over complete East matches', () => {
  const tag = process.env.BF_MP_TAG ?? 'pilot', from = Number(process.env.BF_MP_FROM ?? 1200001), seeds = Number(process.env.BF_MP_SEEDS ?? 4)
  if (!/^[a-zA-Z0-9_-]+$/.test(tag) || !Number.isSafeInteger(from) || !Number.isSafeInteger(seeds)
    || from < 1 || seeds < 1 || seeds > 1000) throw new Error('Invalid run budget')
  const dir = `work/blood-flow-meld-projection/${tag}`
  if (existsSync(`${dir}/metadata.json`)) throw new Error('Use a fresh tag')
  mkdirSync(dir, { recursive: true })
  const started = Date.now(), sourceFingerprint = fingerprint()
  const metadata = { tag, from, seeds, roundsPerMatch:4, candidateSeatsPerSeed:4,
    startedAt: new Date(started).toISOString(), sourceFingerprint,
    commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), apiRequests:0,
    control:MELD_CONTROL_CONFIG, fixed:MELD_FIXED_CONFIG, ruleConfig:BLOOD_FLOW_CONFIG, actionPriority:BLOOD_FLOW_ACTION_PRIORITY,
    protocol:'Only meld projection differs; opportunity guard stays on in both arms. 1 candidate vs 3 controls, four-seat rotation, score carry across 4 rounds, seed-cluster inference. No hidden-state policy input.' }
  writeFileSync(`${dir}/metadata.json`, JSON.stringify(metadata,null,2))
  const all: ContestRow[] = []
  for (let seed = from; seed < from + seeds; seed++) {
    const result = pairedContest(seed,4,true,meldFixed,meldControl)
    all.push(...result.rows)
    writeFileSync(`${dir}/seed-${seed}.json`,JSON.stringify(result,null,2))
    writeFileSync(`${dir}/progress.json`,JSON.stringify({completedSeeds:seed-from+1,matches:all.length,
      changedMatches:all.filter(r=>r.diverged).length,elapsedSeconds:(Date.now()-started)/1000}))
  }
  expect(fingerprint()).toBe(sourceFingerprint)
  writeFileSync(`${dir}/summary.json`,JSON.stringify({metadata,elapsedSeconds:(Date.now()-started)/1000,summary:summary(all)},null,2))
},7_200_000)
