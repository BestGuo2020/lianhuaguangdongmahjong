import { readFileSync, writeFileSync } from 'node:fs'
const tags = process.argv.slice(2)
if (!tags.length || tags.some(t => !/^[a-z0-9-]+$/.test(t))) throw new Error('Pass completed run tags')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const mean = values => values.reduce((a,b)=>a+b,0)/values.length
function summary(rows, metric) {
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.panel}/${row.seed}`
    groups.set(key,[...(groups.get(key)??[]),metric(row)])
  }
  const values = [...groups.values()].map(mean)
  let state = 912701
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state>>>0)/4294967296 }
  const boot = []
  for (let b=0;b<4000;b++) boot.push(mean(values.map(()=>values[Math.floor(random()*values.length)])))
  boot.sort((a,b)=>a-b)
  return {sourceSeeds:values.length,matches:rows.length,mean:mean(values),ci95:values.length>1?[boot[99],boot[3899]]:null}
}
const seen = new Set(), fingerprints = new Set()
const runs = tags.map(tag => {
  const dir = `work/blood-flow-forecast/${tag}`, metadata = read(`${dir}/metadata.json`), done = read(`${dir}/summary.json`)
  if (JSON.stringify(metadata)!==JSON.stringify(done.metadata)) throw new Error('Metadata mismatch')
  fingerprints.add(metadata.sourceFingerprint)
  const rows = []
  for(let seed=metadata.from;seed<metadata.from+metadata.seeds;seed++) {
    const key = `${metadata.variant}/${metadata.panel}/${seed}`
    if(seen.has(key)) throw new Error('Duplicate source seed')
    seen.add(key)
    const data = read(`${dir}/seed-${seed}.json`)
    if(data.length!==4 || new Set(data.map(r=>r.focal)).size!==4) throw new Error('Missing focal seat')
    for(const row of data) if(row.seed!==seed || row.panel!==metadata.panel || row.rounds!==4
      || row.currentNet-row.controlNet!==row.delta || (!row.changed && row.delta!==0)) throw new Error('Paired accounting mismatch')
    rows.push(...data)
  }
  return {tag,...done,rows}
})
if(fingerprints.size!==1) throw new Error('Analyze pilot and validation fingerprints separately')
const variants = ['forecast','search'].filter(v=>runs.some(r=>r.metadata.variant===v)).map(variant=> {
  const selected = runs.filter(r=>r.metadata.variant===variant), rows = selected.flatMap(r=>r.rows)
  const metrics = rows => ({delta:summary(rows,r=>r.delta),
    firstPlaceDelta:summary(rows,r=>Number(r.currentRank===1)-Number(r.controlRank===1)),
    rankDelta:summary(rows,r=>r.currentRank-r.controlRank),changedMatches:rows.filter(r=>r.changed).length})
  return {variant,pooled:metrics(rows),profiles:[...new Set(rows.map(r=>r.panel))].map(panel=>({panel,...metrics(rows.filter(r=>r.panel===panel))})),
    expanded:selected.reduce((n,r)=>n+r.expanded,0),promotions:selected.reduce((n,r)=>n+r.promotions,0),
    worst:[...rows].sort((a,b)=>a.delta-b.delta).slice(0,3).map(({panel,seed,focal,delta})=>({panel,seed,focal,delta}))}
})
const result = {scope:'Synthetic mixed/defensive opponents only. Cluster by source seed, four focal seats. Search compares against the new forecast, not against production. Timing includes concurrent load. No promotion solely from these intervals.',variants,runs}
writeFileSync(`work/blood-flow-forecast/analysis-${tags[0]}.json`,JSON.stringify(result,null,2))
console.log(JSON.stringify(variants,null,2))
