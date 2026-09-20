import { readFileSync,writeFileSync } from 'node:fs'
const tags=process.argv.slice(2)
if(!tags.length||tags.some(t=>!/^[a-z0-9.-]+$/.test(t)))throw new Error('Pass completed batch tags')
const read=p=>JSON.parse(readFileSync(p,'utf8')),mean=v=>v.reduce((a,b)=>a+b,0)/v.length
function summary(rows,metric){
  const groups=new Map()
  for(const r of rows){const k=`${r.panel}/${r.seed}`;groups.set(k,[...(groups.get(k)??[]),metric(r)])}
  const values=[...groups.values()].map(mean);let state=912701
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296}
  const boot=Array.from({length:4000},()=>mean(values.map(()=>values[Math.floor(random()*values.length)]))).sort((a,b)=>a-b)
  return {clusters:values.length,matches:rows.length,mean:mean(values),ci95:[boot[99],boot[3899]]}
}
const seen=new Set(),fingerprints=new Set(),models=new Set()
const runs=tags.map(tag=>{
  const dir=`work/blood-flow-opportunity/${tag}`,done=read(`${dir}/summary.json`),m=read(`${dir}/metadata.json`)
  if(JSON.stringify(m)!==JSON.stringify(done.metadata))throw new Error('Mismatched metadata')
  fingerprints.add(m.sourceFingerprint);models.add(JSON.stringify([m.candidateConfig.opportunityCalibration,m.candidateConfig.conditionalRon]))
  if(done.rows.length!==m.seeds*4)throw new Error('Missing rows')
  for(let seed=m.from;seed<m.from+m.seeds;seed++) {
    const key=`${m.mode}/${m.ratio}/${m.panel}/${seed}`
    if(seen.has(key))throw new Error('Duplicate source');seen.add(key)
    const rows=done.rows.filter(r=>r.seed===seed)
    if(rows.length!==4||new Set(rows.map(r=>r.focal)).size!==4)throw new Error('Missing seats')
    for(const r of rows)if(r.panel!==m.panel||r.currentNet-r.controlNet!==r.delta)throw new Error('Accounting mismatch')
  }
  return {tag,...done}
})
if(fingerprints.size!==1||models.size!==1)throw new Error('Mixed source/model versions')
const groups=[...new Set(runs.map(r=>`${r.metadata.mode}/${r.metadata.ratio}`))].map(key=>{
  const selected=runs.filter(r=>`${r.metadata.mode}/${r.metadata.ratio}`===key),rows=selected.flatMap(r=>r.rows)
  return {key,delta:summary(rows,r=>r.delta),firstPlace:summary(rows,r=>Number(r.currentRank===1)-Number(r.controlRank===1)),
    changed:rows.filter(r=>r.changed).length,profiles:[...new Set(rows.map(r=>r.panel))].map(panel=>({panel,delta:summary(rows.filter(r=>r.panel===panel),r=>r.delta)}))}
})
// Predeclared training rule: maximize paired mean, default 1.2 for ties/negative alternatives.
const candidates=[{ratio:1.2,mean:0},...groups.filter(g=>g.key.startsWith('threshold/')).map(g=>({ratio:Number(g.key.split('/')[1]),mean:g.delta.mean}))]
const selected=[...candidates].sort((a,b)=>b.mean-a.mean||Math.abs(a.ratio-1.2)-Math.abs(b.ratio-1.2))[0].ratio
const result={groups,trainingSelectionRule:'Highest paired mean; ties prefer 1.2. Selection only applies when these tags are the training batches.',selected,runs}
writeFileSync(`work/blood-flow-opportunity/analysis-${tags[0]}.json`,JSON.stringify(result,null,2))
console.log(JSON.stringify({groups,selected},null,2))
