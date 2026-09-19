import { readFileSync, writeFileSync } from 'node:fs'

const tags = process.argv.slice(2)
if (!tags.length || tags.some(tag => !/^[a-zA-Z0-9_-]+$/.test(tag))) {
  throw new Error('Usage: node scripts/analyze-blood-flow-counterfactual.mjs <completed-tag> [completed-tag...]')
}
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
function summary(rows) {
  const bySeed = new Map()
  for (const row of rows) bySeed.set(row.seed, [...(bySeed.get(row.seed) ?? []), row.value])
  const values = [...bySeed.values()].map(average)
  if (values.length < 2) return { sourceSeeds: values.length, windows: rows.length, mean: average(values), ci95: null }
  let state = 912701
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296 }
  const draws = []
  for (let b = 0; b < 4000; b++) {
    let total = 0
    for (let i = 0; i < values.length; i++) total += values[Math.floor(random() * values.length)]
    draws.push(total / values.length)
  }
  draws.sort((a, b) => a - b)
  return { sourceSeeds: values.length, windows: rows.length, mean: average(values), ci95: [draws[99], draws[3899]] }
}

const batches = tags.map(tag => {
  const dir = `work/blood-flow-counterfactual/${tag}`
  const completed = read(`${dir}/summary.json`), metadata = read(`${dir}/metadata.json`)
  if (JSON.stringify(metadata) !== JSON.stringify(completed.metadata)) throw new Error(`Metadata mismatch: ${tag}`)
  const records = []
  for (let seed = metadata.seedFrom; seed < metadata.seedFrom + metadata.rounds; seed++) {
    const rows = read(`${dir}/seed-${seed}.json`)
    for (const row of rows) {
      if (row.seed !== seed || row.outcomes.length !== row.plan.candidates.length * (metadata.samples + 1)) throw new Error('Incomplete window')
      for (const candidate of row.plan.candidates) for (let sample = -1; sample < metadata.samples; sample++) {
        if (row.outcomes.filter(o => o.sample === sample && o.candidateId === candidate.id).length !== 1) throw new Error('Missing/duplicate outcome')
      }
    }
    records.push(...rows)
  }
  if (records.length !== completed.summary.windows) throw new Error('Window count mismatch')
  return { tag, metadata, records, elapsedSeconds: completed.elapsedSeconds }
})
const keys = new Set(), settings = new Set()
for (const batch of batches) {
  settings.add(`${batch.metadata.sourceFingerprint}/${batch.metadata.configHash}/${batch.metadata.samples}`)
  for (let seed = batch.metadata.seedFrom; seed < batch.metadata.seedFrom + batch.metadata.rounds; seed++) {
    if (keys.has(seed)) throw new Error('Overlapping source seeds cannot be pooled')
    keys.add(seed)
  }
}
if (settings.size !== 1) throw new Error('Source/config/sample counts differ; do not pool')

const comparisons = [
  ['win', 'baseline'], ['reform-1', 'baseline'], ['reform-2', 'baseline'], ['decline-discard', 'baseline'],
  ['reform-1', 'win'], ['reform-2', 'win'], ['decline-discard', 'win'],
]
function compact(row) {
  const { plan } = row
  const pairs = {}
  for (const [role, reference] of comparisons) {
    const chosen = plan.candidates.find(c => c.roles.includes(role)), control = plan.candidates.find(c => c.roles.includes(reference))
    if (!chosen || !control) continue
    const outcomes = row.outcomes.filter(o => o.sample >= 0 && o.candidateId === chosen.id)
    const deltas = outcomes.map(o => o.net - row.outcomes.find(c => c.sample === o.sample && c.candidateId === control.id).net)
    const actual = id => row.outcomes.find(o => o.sample === -1 && o.candidateId === id).net
    pairs[`${role}-minus-${reference}`] = { mean: average(deltas), pairedDeltas: deltas, originalWallDelta: actual(chosen.id) - actual(control.id) }
  }
  const outcomes = plan.candidates.map(candidate => {
    const rows = row.outcomes.filter(o => o.sample >= 0 && o.candidateId === candidate.id)
    return { ...candidate, net: average(rows.map(o => o.net)), grossWinIncome: average(rows.map(o => o.grossWinIncome)),
      payments: average(rows.map(o => o.payments)), discardPayments: average(rows.map(o => o.discardPayments)),
      kongNet: average(rows.map(o => o.kongNet)), wins: average(rows.map(o => o.wins)) }
  })
  return { seed: row.seed, step: row.step, ...plan, outcomes, pairs }
}
function summarize(windows) {
  const result = {}
  for (const [role, reference] of comparisons) {
    const key = `${role}-minus-${reference}`
    const eligible = windows.filter(w => w.pairs[key])
    result[key] = { ...summary(eligible.map(w => ({ seed: w.seed, value: w.pairs[key].mean }))),
      positiveWindows: eligible.filter(w => w.pairs[key].mean > 0).length,
      negativeWindows: eligible.filter(w => w.pairs[key].mean < 0).length,
      identicalActions: eligible.filter(w => w.candidates.some(c => c.roles.includes(role) && c.roles.includes(reference))).length }
  }
  return result
}
const windows = batches.flatMap(batch => batch.records.map(row => ({ batch: batch.tag, ...compact(row) })))
const result = {
  tags, sourceFingerprint: batches[0].metadata.sourceFingerprint, configHash: batches[0].metadata.configHash,
  actionPriority: batches[0].metadata.actionPriority,
  sourceRounds: keys.size, windows: windows.length, permutationSamplesPerWindow: batches[0].metadata.samples,
  apiRequests: 0, interval: 'Seed-cluster percentile bootstrap, 4000 resamples, equal weight per source seed with eligible windows; exploratory.',
  scope: batches[0].metadata.uncertainty,
  batches: batches.map(batch => ({ tag: batch.tag, seedFrom: batch.metadata.seedFrom, rounds: batch.metadata.rounds,
    elapsedSeconds: batch.elapsedSeconds, windows: batch.records.length, comparisons: summarize(windows.filter(w => w.batch === batch.tag)) })),
  pooled: summarize(windows),
  byStage: Object.fromEntries(['early', 'mid', 'late'].map(stage => [stage, summarize(windows.filter(w => w.stage === stage))])),
  byBaselineAction: Object.fromEntries(['win', 'discard', 'concealed-kong', 'added-kong', 'wind-kong', 'pass'].map(kind =>
    [kind, summarize(windows.filter(w => w.candidates.find(c => c.id === w.baselineId).action.kind === kind))])),
  windowsDetail: windows,
}
const output = `work/blood-flow-counterfactual/analysis-${tags.join('-')}.json`
writeFileSync(output, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ output, sourceRounds: result.sourceRounds, windows: result.windows, pooled: result.pooled }, null, 2))
