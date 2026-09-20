import {readFileSync,writeFileSync} from 'node:fs'
const tags=process.argv.slice(2),read=p=>JSON.parse(readFileSync(p,'utf8'))
if(!tags.length||tags.some(t=>!/^[a-z0-9-]+$/.test(t)))throw new Error('Pass completed batch tags')
const fingerprints=new Set(),ensembles=new Set(),configs=new Set(),seen=new Set()
const runs=tags.map(tag=>{
  const dir=`work/blood-flow-ranking/${tag}`,m=read(`${dir}/metadata.json`),done=read(`${dir}/summary.json`)
  if(JSON.stringify(m)!==JSON.stringify(done.metadata)||done.rows.length!==m.seeds*4)throw new Error('Incomplete batch')
  fingerprints.add(m.sourceFingerprint);ensembles.add(m.ensembleHash);configs.add(JSON.stringify([m.base,m.model]))
  for(let seed=m.from;seed<m.from+m.seeds;seed++){
    const key=`${m.mode}/${m.panel}/${seed}`;if(seen.has(key))throw new Error('Duplicate seed');seen.add(key)
    const rows=done.rows.filter(r=>r.seed===seed)
    if(rows.length!==4||new Set(rows.map(r=>r.focal)).size!==4)throw new Error('Missing focal seat')
    for(const r of rows)if(r.panel!==m.panel||r.rounds!==4||r.currentNet-r.controlNet!==r.delta)throw new Error('Bad accounting')
  }
  return {tag,...done}
})
if(fingerprints.size!==1||ensembles.size!==1||configs.size!==1)throw new Error('Mixed policies/source/ensemble')
const mean=v=>v.reduce((a,b)=>a+b,0)/v.length
function summary(rows,f){
  const groups=new Map()
  for(const r of rows){const key=`${r.panel}/${r.seed}`;groups.set(key,[...(groups.get(key)??[]),f(r)])}
  const values=[...groups.values()].map(mean);let state=912701
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296}
  const boot=Array.from({length:4000},()=>mean(values.map(()=>values[Math.floor(random()*values.length)]))).sort((a,b)=>a-b)
  return {sourceSeeds:values.length,matches:rows.length,mean:mean(values),ci95:[boot[99],boot[3899]]}
}
const modes=['raw','robust'].map(mode=>{
  const chosen=runs.filter(r=>r.metadata.mode===mode),rows=chosen.flatMap(r=>r.rows),audit=chosen.flatMap(r=>r.audit)
  if(!rows.length)throw new Error('Both modes required')
  return {mode,delta:summary(rows,r=>r.delta),firstPlaceDelta:summary(rows,r=>Number(r.currentRank===1)-Number(r.controlRank===1)),
    changedMatches:rows.filter(r=>r.changed).length,largeDeteriorations:rows.filter(r=>r.delta<=-500).length,
    worst:[...rows].sort((a,b)=>a.delta-b.delta).slice(0,3).map(({panel,seed,focal,delta})=>({panel,seed,focal,delta})),
    profiles:[...new Set(rows.map(r=>r.panel))].map(panel=>({panel,delta:summary(rows.filter(r=>r.panel===panel),r=>r.delta)})),
    auditedViews:audit.length,parameterStableViews:audit.filter(r=>r.parameterStable).length,acceptedViews:audit.filter(r=>r.accept).length}
})
const raw=runs.filter(r=>r.metadata.mode==='raw').flatMap(r=>r.rows),robust=runs.filter(r=>r.metadata.mode==='robust').flatMap(r=>r.rows)
if(raw.length!==robust.length)throw new Error('Unpaired arms')
const key=r=>`${r.panel}/${r.seed}/${r.focal}`,index=new Map(raw.map(r=>[key(r),r]))
const pairs=robust.map(r=>{
  const old=index.get(key(r));if(!old||old.controlNet!==r.controlNet||old.controlRank!==r.controlRank)throw new Error('Control path mismatch')
  return {...r,versusRaw:r.currentNet-old.currentNet}
})
const result={scope:'Fresh complete matches; same source-v2 control. Raw and robust change only qualified reform rankings. Parameter bootstrap is not outcome confidence; 5% deadband was fixed before these runs. No selection of a new threshold on validation.',modes,
  robustMinusRaw:summary(pairs,r=>r.versusRaw),runs}
writeFileSync('work/blood-flow-ranking/analysis.json',JSON.stringify(result,null,2))
console.log(JSON.stringify({modes,robustMinusRaw:result.robustMinusRaw},null,2))
