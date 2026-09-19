import { readFileSync, writeFileSync } from 'node:fs'

const tags = process.argv.slice(2)
if (!tags.length || tags.some(tag => !/^[a-zA-Z0-9_-]+$/.test(tag))) throw new Error('Pass completed batch tags')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
const sum = values => values.reduce((a, b) => a + b, 0)
function clustered(rows, value) {
  const groups = new Map()
  for (const row of rows) groups.set(row.seed, [...(groups.get(row.seed) ?? []), value(row)])
  const values = [...groups.values()].map(mean), average = mean(values)
  if (values.length < 2) return { sourceSeeds: values.length, matches: rows.length, mean: average, se: null, ci95: null }
  const se = Math.sqrt(sum(values.map(v => (v - average) ** 2)) / (values.length - 1) / values.length)
  let state = 912701
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296 }
  const samples = []
  for (let b = 0; b < 4000; b++) {
    let total = 0
    for (let i = 0; i < values.length; i++) total += values[Math.floor(random() * values.length)]
    samples.push(total / values.length)
  }
  samples.sort((a, b) => a - b)
  return { sourceSeeds: values.length, matches: rows.length, mean: average, se, ci95: [samples[99], samples[3899]],
    normalApproxCi95: [average - 1.96 * se, average + 1.96 * se],
    positiveSeeds: values.filter(v => v > 0).length, negativeSeeds: values.filter(v => v < 0).length,
    zeroSeeds: values.filter(v => v === 0).length }
}

const settings = new Set(), usedSeeds = new Set()
const batches = tags.map(tag => {
  const dir = `work/blood-flow-route-opportunity/${tag}`
  const metadata = read(`${dir}/metadata.json`), completed = read(`${dir}/summary.json`)
  if (JSON.stringify(metadata) !== JSON.stringify(completed.metadata)) throw new Error('Incomplete or mismatched batch')
  settings.add(JSON.stringify([metadata.sourceFingerprint, metadata.configHash, metadata.spec, metadata.roundsPerMatch]))
  const results = []
  for (let seed = metadata.seedFrom; seed < metadata.seedFrom + metadata.seeds; seed++) {
    if (usedSeeds.has(seed)) throw new Error('Overlapping source seeds')
    usedSeeds.add(seed)
    const result = read(`${dir}/seed-${seed}.json`)
    if (result.seed !== seed || result.rounds !== 4 || sum(result.controlNet) !== 0
      || result.rows.length !== 4 || new Set(result.rows.map(r => r.seat)).size !== 4) throw new Error('Invalid complete match')
    for (const row of result.rows) {
      if (row.seed !== seed || row.roundNet.length !== 4 || sum(row.roundNet) !== row.net
        || row.deltaVsControl !== row.net - result.controlNet[row.seat]
        || (!row.diverged && row.deltaVsControl !== 0)) throw new Error('Match accounting mismatch')
      row.controlRank = 1 + result.controlNet.filter(net => net > result.controlNet[row.seat]).length
      row.controlFirstPlace = row.controlRank === 1
    }
    results.push(result)
  }
  return { tag, metadata, elapsedSeconds: completed.elapsedSeconds, results }
})
if (settings.size !== 1) throw new Error('Cannot pool different source/config/policy versions')

function describe(rows) {
  const events = rows.flatMap(r => r.gateEvents)
  const primary = clustered(rows, r => r.net)
  const paired = clustered(rows, r => r.deltaVsControl)
  if (Math.abs(primary.mean - paired.mean) > 1e-9) throw new Error('Seat balancing failed')
  return { netPerEastMatch: primary, pairedIncrementPerEastMatch: paired,
    incrementPerRound: clustered(rows, r => r.deltaVsControl / 4),
    firstPlaceRate: clustered(rows, r => Number(r.firstPlace)), meanRank: clustered(rows, r => r.rank),
    firstPlaceRateDelta: clustered(rows, r => Number(r.firstPlace) - Number(r.controlFirstPlace)),
    rankDelta: clustered(rows, r => r.rank - r.controlRank),
    winsPerMatch: clustered(rows, r => r.wins),
    bigDiscardLossDeltaPerMatch: clustered(rows, r => r.bigDiscardLoss - r.controlBigDiscardLoss),
    candidateBigDiscardLoss: mean(rows.map(r => r.bigDiscardLoss)), baselineBigDiscardLoss: mean(rows.map(r => r.controlBigDiscardLoss)),
    divergedMatches: rows.filter(r => r.diverged).length, positiveMatches: rows.filter(r => r.deltaVsControl > 0).length,
    negativeMatches: rows.filter(r => r.deltaVsControl < 0).length,
    triggeredDecisions: events.length, changedDecisions: events.filter(e => e.changed).length,
    changedToWin: events.filter(e => e.changed && e.chosen.kind === 'win').length,
    changedToNonWin: events.filter(e => e.changed && e.chosen.kind !== 'win').length,
    routes: Object.fromEntries([...new Set(events.map(e => e.route))].sort().map(route => [route, events.filter(e => e.route === route).length])),
    worstMatches: [...rows].sort((a, b) => a.deltaVsControl - b.deltaVsControl).slice(0, 5).map(r => ({ seed: r.seed, seat: r.seat, delta: r.deltaVsControl })),
    bestMatches: [...rows].sort((a, b) => b.deltaVsControl - a.deltaVsControl).slice(0, 5).map(r => ({ seed: r.seed, seat: r.seat, delta: r.deltaVsControl })),
  }
}
const rows = batches.flatMap(b => b.results.flatMap(r => r.rows))
const result = { schema: 1, tags, spec: batches[0].metadata.spec, configHash: batches[0].metadata.configHash,
  sourceFingerprint: batches[0].metadata.sourceFingerprint, commit: batches[0].metadata.commit,
  sourceSeeds: usedSeeds.size, candidateEastMatches: rows.length, candidateCompleteRounds: rows.length * 4,
  controlEastMatches: usedSeeds.size, controlCompleteRounds: usedSeeds.size * 4,
  actualCommandsComputed: sum(batches.flatMap(b => b.results.map(r => r.actualCommands))), apiRequests: 0,
  interval: '4000 source-seed bootstrap replicates; each seed averages its four seat-rotated East matches; includes no-change matches.',
  batches: batches.map(b => ({ tag: b.tag, seedFrom: b.metadata.seedFrom, seeds: b.metadata.seeds,
    elapsedSeconds: b.elapsedSeconds, summary: describe(b.results.flatMap(r => r.rows)) })),
  pooled: describe(rows), seedResults: batches.flatMap(b => b.results),
}
const output = `work/blood-flow-route-opportunity/analysis-${tags.join('-')}.json`
writeFileSync(output, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ output, seeds: result.sourceSeeds, matches: result.candidateEastMatches, pooled: result.pooled }, null, 2))
