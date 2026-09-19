import { readFileSync, writeFileSync } from 'node:fs'
const tags = process.argv.slice(2)
const study = tags[0]?.startsWith('--study=') ? tags.shift().slice('--study='.length) : 'meld-projection'
if (!['meld-projection','ready-net'].includes(study)) throw new Error('Unknown study')
if (!tags.length || tags.some(t => !/^[a-zA-Z0-9_-]+$/.test(t))) throw new Error('Pass completed batch tags')
const read = path => JSON.parse(readFileSync(path,'utf8'))
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null
function metric(rows, fn) {
  const groups = new Map()
  for (const row of rows) groups.set(row.seed,[...(groups.get(row.seed)??[]),fn(row)])
  const values = [...groups.values()].map(mean), average = mean(values)
  if(values.length<2) return {seeds:values.length,matches:rows.length,mean:average,ci95:null}
  const se = Math.sqrt(values.reduce((s,v)=>s+(v-average)**2,0)/(values.length-1)/values.length)
  let state=912701
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296}
  const samples=[]
  for(let b=0;b<4000;b++) {
    let sum=0
    for(let i=0;i<values.length;i++) sum+=values[Math.floor(random()*values.length)]
    samples.push(sum/values.length)
  }
  samples.sort((a,b)=>a-b)
  return {seeds:values.length,matches:rows.length,mean:average,se,ci95:[samples[99],samples[3899]],
    normalApproxCi95:[average-1.96*se,average+1.96*se],positiveSeeds:values.filter(v=>v>0).length,
    negativeSeeds:values.filter(v=>v<0).length,zeroSeeds:values.filter(v=>v===0).length}
}
const used=new Set(),settings=new Set()
const batches=tags.map(tag=>{
  const dir=`work/blood-flow-${study}/${tag}`,metadata=read(`${dir}/metadata.json`),done=read(`${dir}/summary.json`)
  if(JSON.stringify(metadata)!==JSON.stringify(done.metadata)) throw new Error('Incomplete batch')
  settings.add(JSON.stringify([metadata.sourceFingerprint,metadata.control,metadata.fixed,metadata.ruleConfig,metadata.actionPriority]))
  const results=[]
  for(let seed=metadata.from;seed<metadata.from+metadata.seeds;seed++) {
    if(used.has(seed))throw new Error('Overlapping seed')
    used.add(seed)
    const result=read(`${dir}/seed-${seed}.json`)
    if(result.seed!==seed||result.rounds!==4||result.rows.length!==4||new Set(result.rows.map(r=>r.seat)).size!==4
      ||result.controlNet.reduce((a,b)=>a+b,0)!==0)throw new Error('Invalid match')
    for(const row of result.rows) {
      if(row.roundNet.reduce((a,b)=>a+b,0)!==row.net||row.net-result.controlNet[row.seat]!==row.deltaVsControl
        ||(!row.diverged&&row.deltaVsControl!==0))throw new Error('Invalid paired accounting')
      if(study==='ready-net'&&row.decisionChanges.some(c=>!['chi','peng'].includes(c.original.kind)||c.chosen.kind!=='pass'))
        throw new Error('Readiness veto changed behavior outside its registered chi/peng-to-pass scope')
      row.controlRank=1+result.controlNet.filter(v=>v>result.controlNet[row.seat]).length
    }
    results.push(result)
  }
  return {tag,metadata,elapsedSeconds:done.elapsedSeconds,results}
})
if(settings.size!==1)throw new Error('Policy/config/source differs')
function summarize(rows) {
  const changes=rows.flatMap(r=>r.decisionChanges)
  return {primary:metric(rows,r=>r.deltaVsControl),perRound:metric(rows,r=>r.deltaVsControl/4),
    net:metric(rows,r=>r.net),firstPlaceDelta:metric(rows,r=>Number(r.firstPlace)-Number(r.controlRank===1)),
    rankDelta:metric(rows,r=>r.rank-r.controlRank),bigDiscardLossDelta:metric(rows,r=>r.bigDiscardLoss-r.controlBigDiscardLoss),
    changedMatches:rows.filter(r=>r.diverged).length,positiveMatches:rows.filter(r=>r.deltaVsControl>0).length,
    negativeMatches:rows.filter(r=>r.deltaVsControl<0).length,changedDecisions:changes.length,
    transitions:Object.fromEntries([...new Set(changes.map(c=>`${c.original.kind}->${c.chosen.kind}`))].sort().map(key=>
      [key,changes.filter(c=>`${c.original.kind}->${c.chosen.kind}`===key).length])),
    worst:[...rows].sort((a,b)=>a.deltaVsControl-b.deltaVsControl).slice(0,5).map(r=>({seed:r.seed,seat:r.seat,delta:r.deltaVsControl})),
    best:[...rows].sort((a,b)=>b.deltaVsControl-a.deltaVsControl).slice(0,5).map(r=>({seed:r.seed,seat:r.seat,delta:r.deltaVsControl}))}
}
const rows=batches.flatMap(b=>b.results.flatMap(r=>r.rows)),pooled=summarize(rows)
if(Math.abs(pooled.primary.mean-pooled.net.mean)>1e-9)throw new Error('Seat balancing failed')
const result={schema:1,tags,sourceFingerprint:batches[0].metadata.sourceFingerprint,control:batches[0].metadata.control,
  fixed:batches[0].metadata.fixed,sourceSeeds:used.size,candidateMatches:rows.length,candidateRounds:rows.length*4,
  controlMatches:used.size,controlRounds:used.size*4,apiRequests:0,pooled,
  batches:batches.map(b=>({tag:b.tag,from:b.metadata.from,seeds:b.metadata.seeds,elapsedSeconds:b.elapsedSeconds,
    summary:summarize(b.results.flatMap(r=>r.rows))})),seedResults:batches.flatMap(b=>b.results)}
const output=`work/blood-flow-${study}/analysis-${tags.join('-')}.json`
writeFileSync(output,JSON.stringify(result,null,2))
console.log(JSON.stringify({output,sourceSeeds:used.size,candidateMatches:rows.length,pooled},null,2))
