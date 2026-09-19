/** Next loss-source screen. Current production policy, fixed hidden hands, paired future walls. */
import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG, BLOOD_FLOW_ACTION_PRIORITY } from '../src/game/variants/lotus/bloodFlow/config'
import { newRound, nextSeatToAct, snapshotEngine, submit, rollout, mean, clusterSummary,
  type Candidate, type Outcome, type Policy } from './blood-flow-counterfactual'
import type { Seat } from '../src/game/variants/lotus/bloodFlow/types'

const production: Policy = view => decideBloodFlowActionEv(view, BLOOD_FLOW_AI)
function fingerprint() {
  const files: string[] = []
  const visit = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) visit(path)
    else if (item.name.endsWith('.ts')) files.push(path)
  } }
  visit('src/game')
  files.push('scripts/blood-flow-counterfactual.ts', 'scripts/blood-flow-meld-counterfactual-run.test.ts')
  const hash = createHash('sha256')
  for (const path of files.sort()) hash.update(path.replaceAll('\\', '/')).update('\0').update(readFileSync(path)).update('\0')
  return hash.digest('hex')
}
const candidates = (action: Candidate['action']): Candidate[] => [
  { id: 'accept', roles: ['baseline'], action }, { id: 'pass', roles: ['alternative'], action: { kind: 'pass' } },
]
function sample(checkpoint: Record<string, unknown>, seat: Seat, choices: Candidate[], count: number, key: string, original: boolean) {
  const outcomes: Outcome[] = []
  for (let repetition = original ? -1 : 0; repetition < count; repetition++) {
    const wallSeed = createHash('sha256').update(`${key}:${repetition}`).digest().readUInt32LE(0)
    for (const candidate of choices) outcomes.push(rollout(checkpoint, { seat }, candidate, repetition, wallSeed, production))
  }
  return outcomes
}
function paired(outcomes: Outcome[], field: keyof Pick<Outcome, 'net' | 'grossWinIncome' | 'payments' | 'discardPayments' | 'kongNet'> = 'net') {
  return outcomes.filter(o => o.sample >= 0 && o.candidateId === 'pass').map(o =>
    o[field] - outcomes.find(c => c.sample === o.sample && c.candidateId === 'accept')![field])
}
function summarize(rows: any[]) {
  const summarizeGroup = (records: any[]) => ({
    passMinusAccept: clusterSummary(records.map(r => ({ seed: r.seed, value: mean(paired(r.outcomes))! }))),
    positiveWindows: records.filter(r => mean(paired(r.outcomes))! > 0).length,
    negativeWindows: records.filter(r => mean(paired(r.outcomes))! < 0).length,
    sampleWindows: records.length,
  })
  return { all: summarizeGroup(rows), byKind: Object.fromEntries(['chi', 'peng', 'gang'].map(kind =>
    [kind, summarizeGroup(rows.filter(r => r.action.kind === kind))])),
    windows: rows.map(r => ({ ...r, passMinusAccept: mean(paired(r.outcomes)),
      incomeDelta: mean(paired(r.outcomes, 'grossWinIncome')), paymentDelta: mean(paired(r.outcomes, 'payments')),
      discardPaymentDelta: mean(paired(r.outcomes, 'discardPayments')), kongNetDelta: mean(paired(r.outcomes, 'kongNet')) })) }
}

it.skipIf(process.env.BF_MELD_RUN !== '1')('screens accepted mid/late melds against pass', () => {
  const from = Number(process.env.BF_MELD_FROM ?? 1100001), rounds = Number(process.env.BF_MELD_ROUNDS ?? 8)
  const samples = Number(process.env.BF_MELD_SAMPLES ?? 4), tag = process.env.BF_MELD_TAG ?? 'screen-v1'
  if (!/^[a-zA-Z0-9_-]+$/.test(tag) || ![from, rounds, samples].every(Number.isSafeInteger)
    || from < 1 || rounds < 1 || rounds > 1000 || samples < 1 || samples > 128) throw new Error('Invalid run budget')
  const dir = `work/blood-flow-meld-counterfactual/${tag}`
  if (existsSync(`${dir}/metadata.json`)) throw new Error('Use a new tag')
  mkdirSync(dir, { recursive: true })
  const started = Date.now(), sourceFingerprint = fingerprint(), all: any[] = []
  const metadata = { tag, from, rounds, samples, sourceFingerprint,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    aiConfig: BLOOD_FLOW_AI, ruleConfig: BLOOD_FLOW_CONFIG, actionPriority: BLOOD_FLOW_ACTION_PRIORITY, apiRequests: 0,
    sampling: 'First accepted chi/peng/gang of each kind per source round, wall <=40, unlocked, pass legal, no own win. Not a frequency-weighted population.',
    scope: 'Current production AI in all continuations. Opponent hands and unseen inventory fixed; paired future-wall permutations only. Diagnostic, not deployable oracle.' }
  writeFileSync(`${dir}/metadata.json`, JSON.stringify(metadata, null, 2))
  for (let seed = from; seed < from + rounds; seed++) {
    const engine = newRound(seed, ((seed - from) % 4) as Seat), seen = new Set<string>(), rows: any[] = []
    let steps = 0
    while (!engine.result) {
      if (++steps > 2000) throw new Error('Source round stalled')
      const seat = nextSeatToAct(engine), view = bloodFlowSeatView(engine, seat), action = production(view)!
      if (['chi', 'peng', 'gang'].includes(action.kind) && !seen.has(action.kind) && view.wallCount <= 40
        && !view.public.seats[seat].locked && view.window?.source.kind === 'discard'
        && !view.ownActions.some(a => a.kind === 'win') && view.ownActions.some(a => a.kind === 'pass')) {
        seen.add(action.kind)
        const key = `${seed}-${action.kind}`, checkpoint = snapshotEngine(engine), choices = candidates(action)
        const row = { key, seed, seat, step: steps, wall: view.wallCount, action, source: view.window.source,
          hand: view.players[seat].hand, melds: view.players[seat].melds, jokers: view.jokers,
          scoreBefore: engine.players[seat].score, outcomes: sample(checkpoint, seat, choices, samples, `screen:${key}`, true) }
        writeFileSync(`${dir}/${key}.bin`, serialize({ checkpoint, seat, choices, row }))
        rows.push(row)
      }
      submit(engine, seat, action)
    }
    for (const row of rows) expect(row.outcomes.find((o: Outcome) => o.sample === -1 && o.candidateId === 'accept')!.net)
      .toBe(engine.players[row.seat].score - row.scoreBefore)
    all.push(...rows)
    writeFileSync(`${dir}/seed-${seed}.json`, JSON.stringify(rows, null, 2))
    writeFileSync(`${dir}/progress.json`, JSON.stringify({ completedRounds: seed - from + 1, windows: all.length,
      rollouts: all.length * (samples + 1) * 2, elapsedSeconds: (Date.now() - started) / 1000 }))
  }
  expect(fingerprint()).toBe(sourceFingerprint)
  writeFileSync(`${dir}/summary.json`, JSON.stringify({ metadata, elapsedSeconds: (Date.now() - started) / 1000, ...summarize(all) }, null, 2))
}, 3_600_000)

it.skipIf(!process.env.BF_MELD_RECHECK)('rechecks selected cases with fresh paired walls', () => {
  const tag = process.env.BF_MELD_TAG ?? 'screen-v1', keys = process.env.BF_MELD_RECHECK!.split(',')
  if (!/^[a-zA-Z0-9_-]+$/.test(tag) || keys.some(key => !/^\d+-(chi|peng|gang)$/.test(key))) throw new Error('Invalid saved case')
  const dir = `work/blood-flow-meld-counterfactual/${tag}`, metadata = JSON.parse(readFileSync(`${dir}/metadata.json`, 'utf8'))
  expect(fingerprint()).toBe(metadata.sourceFingerprint)
  const rows = keys.map(key => {
    const saved = deserialize(readFileSync(`${dir}/${key}.bin`))
    const outcomes = sample(saved.checkpoint, saved.seat, saved.choices, 64, `independent-recheck:${key}`, false)
    const differences = paired(outcomes), average = mean(differences)!
    const se = Math.sqrt(differences.reduce((s, v) => s + (v - average) ** 2, 0) / 63 / 64)
    return { ...saved.row, outcomes, meanDelta: average, se, ci95NormalApprox: [average - 1.96 * se, average + 1.96 * se] }
  })
  writeFileSync(`${dir}/recheck.json`, JSON.stringify({ postHoc: true, samplesPerCase: 64,
    caveat: 'Selected cases; CI covers only fixed-hand wall-order sampling, not generalization across source games.', ...summarize(rows) }, null, 2))
}, 3_600_000)
