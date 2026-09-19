import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deserialize } from 'node:v8'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG, BLOOD_FLOW_ACTION_PRIORITY } from '../src/game/variants/lotus/bloodFlow/config'
import { mean, restoreEngine, rollout, type Outcome, type WindowPlan } from './blood-flow-counterfactual'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { bloodFlowAiActions, decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import { narrowActionsToRoute } from '../src/game/variants/lotus/bloodFlow/bigHandRoute'

function uniquePermutations<T>(items: T[]): T[][] {
  if (!items.length) return [[]]
  const seen = new Set<T>(), result: T[][] = []
  items.forEach((item, index) => {
    if (seen.has(item)) return
    seen.add(item)
    for (const rest of uniquePermutations(items.filter((_, i) => i !== index))) result.push([item, ...rest])
  })
  return result
}

function currentSourceFingerprint() {
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

/** Post-hoc case diagnostics, deliberately NOT pooled into the independent source-seed experiment. */
it.skipIf(process.env.BF_CF_RESAMPLE !== '1')('resamples selected saved windows with fresh wall seeds', () => {
  const tag = process.env.BF_CF_CASE_TAG ?? 'smoke'
  const keys = (process.env.BF_CF_CASES ?? '950002-0,950002-2').split(',')
  const samples = Number(process.env.BF_CF_CASE_SAMPLES ?? 64)
  if (!/^[a-zA-Z0-9_-]+$/.test(tag) || keys.some(key => !/^\d+-[0-3]$/.test(key))
    || !Number.isSafeInteger(samples) || samples < 2 || samples > 1024) throw new Error('Invalid case selection')
  const dir = `work/blood-flow-counterfactual/${tag}`
  const metadata = JSON.parse(readFileSync(`${dir}/metadata.json`, 'utf8'))
  expect(currentSourceFingerprint()).toBe(metadata.sourceFingerprint)
  const configHash = createHash('sha256').update(JSON.stringify([BLOOD_FLOW_CONFIG, BLOOD_FLOW_AI, BLOOD_FLOW_ACTION_PRIORITY])).digest('hex')
  expect(configHash).toBe(metadata.configHash)
  const cases = keys.map(key => {
    const { checkpoint, plan } = deserialize(readFileSync(`${dir}/window-${key}.bin`)) as { checkpoint: Record<string, unknown>; plan: WindowPlan }
    const engine = restoreEngine(checkpoint), view = bloodFlowSeatView(engine, plan.seat)
    const player = view.players[plan.seat]
    const deficit = Math.max(...view.players.filter(p => p.seat !== plan.seat).map(p => p.score)) - player.score
    const route = narrowActionsToRoute(player.hand, player.melds, view.jokers, bloodFlowAiActions(view), {
      config: BLOOD_FLOW_AI.bigHandRoute, basePoints: BLOOD_FLOW_CONFIG.basePoints,
      immediateWinPayment: view.ownScore?.paymentPerPayer ?? 0, wallCount: view.wallCount, scoreDeficit: Math.max(0, deficit),
    })
    const explanation = { scores: view.players.map(p => p.score), deficit, route,
      withoutRouteAction: decideBloodFlowActionEv(view, { ...BLOOD_FLOW_AI,
        bigHandRoute: { ...BLOOD_FLOW_AI.bigHandRoute, mode: 'off' } }) }
    const exhaustiveWalls = engine.wall.length <= 6 ? uniquePermutations([...engine.wall]) : null
    const repetitions = exhaustiveWalls?.length ?? samples
    const outcomes: Outcome[] = []
    for (let sample = 0; sample < repetitions; sample++) {
      // A disjoint PRNG seed family from collection; candidates still share each sampled wall.
      const wallSeed = createHash('sha256').update(`case-confirmation-v1:${key}:${sample}`).digest().readUInt32LE(0)
      const state = exhaustiveWalls ? { ...checkpoint, wall: exhaustiveWalls[sample] } : checkpoint
      for (const candidate of plan.candidates) outcomes.push({
        ...rollout(state, plan, candidate, exhaustiveWalls ? -1 : sample, wallSeed), sample,
      })
    }
    const win = outcomes.filter(o => o.candidateId === 'win')
    const rows = plan.candidates.map(candidate => {
      const chosen = outcomes.filter(o => o.candidateId === candidate.id)
      const differences = chosen.map(o => o.net - win.find(w => w.sample === o.sample)!.net)
      const average = mean(differences)!
      const se = exhaustiveWalls ? 0 : Math.sqrt(differences.reduce((n, d) => n + (d - average) ** 2, 0) / (repetitions - 1) / repetitions)
      return { ...candidate, meanNet: mean(chosen.map(o => o.net)), meanGrossWinIncome: mean(chosen.map(o => o.grossWinIncome)),
        meanPayments: mean(chosen.map(o => o.payments)), minusWin: average, se, ci95NormalApprox: [average - 1.96 * se, average + 1.96 * se],
        positive: differences.filter(d => d > 0).length, negative: differences.filter(d => d < 0).length,
        meanWins: mean(chosen.map(o => o.wins)) }
    })
    return { key, plan, explanation, exhaustive: Boolean(exhaustiveWalls), repetitions, rows, outcomes }
  })
  const result = { sourceMetadata: metadata, samples, postHoc: true,
    caveat: 'Selected cases; intervals cover only wall-order Monte Carlo uncertainty, not source-game sampling or unknown opponents. Not general policy strength.', cases }
  const path = `${dir}/resample-${keys.join('_')}.json`
  writeFileSync(path, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ path, cases: cases.map(c => ({ key: c.key, wall: c.plan.wallCount, rows: c.rows })) }, null, 2))
}, 3_600_000)
