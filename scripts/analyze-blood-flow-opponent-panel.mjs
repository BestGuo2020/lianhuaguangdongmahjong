import {readFileSync,writeFileSync} from 'node:fs'
const tags=process.argv.slice(2)
if(!tags.length||tags.some(t=>!/^[a-zA-Z0-9_-]+$/.test(t)))throw new Error('Pass completed panel tags')
const read=p=>JSON.parse(readFileSync(p,'utf8'))
const mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null
function summary(rows,value){
  const groups=new Map()
  for(const row of rows){const key=`${row.panel}/${row.seed}`;groups.set(key,[...(groups.get(key)??[]),value(row)])}
  const values=[...groups.values()].map(mean),avg=mean(values)
  if(values.length<2)return {sourceSeeds:values.length,observations:rows.length,mean:avg,ci95:null}
  const se=Math.sqrt(values.reduce((s,v)=>s+(v-avg)**2,0)/(values.length-1)/values.length)
  let state=912701
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296}
  const boot=[]
  for(let b=0;b<4000;b++){let s=0;for(let i=0;i<values.length;i++)s+=values[Math.floor(random()*values.length)];boot.push(s/values.length)}
  boot.sort((a,b)=>a-b)
  return {sourceSeeds:values.length,observations:rows.length,mean:avg,se,ci95:[boot[99],boot[3899]]}
}
const settings=new Set(),seen=new Set()
const batches=tags.map(tag=>{
  const dir=`work/blood-flow-opponent-panel/${tag}`,metadata=read(`${dir}/metadata.json`),done=read(`${dir}/summary.json`)
  if(JSON.stringify(metadata)!==JSON.stringify(done.metadata))throw new Error('Incomplete/mismatched batch')
  settings.add(JSON.stringify([metadata.sourceFingerprint,metadata.current,metadata.control,metadata.attack,metadata.defensive,metadata.ruleConfig,metadata.actionPriority]))
  const rows=[]
  for(let seed=metadata.from;seed<metadata.from+metadata.seeds;seed++){
    const key=`${metadata.panel}/${seed}`
    if(seen.has(key))throw new Error('Duplicate profile/seed')
    seen.add(key)
    const data=read(`${dir}/seed-${seed}.json`)
    if(data.length!==4||new Set(data.map(r=>r.focal)).size!==4)throw new Error('Missing focal seat')
    for(const row of data){
      if(row.seed!==seed||row.panel!==metadata.panel||row.rounds!==4||row.currentNet-row.controlNet!==row.delta
        ||(!row.changed&&row.delta!==0))throw new Error('Paired score mismatch')
      for(const o of row.calibration){
        if(o.panel!==row.panel||o.seed!==seed||o.focal!==row.focal||o.ownDrawsObserved>8
          ||![o.predictedChain,o.horizonGross,o.horizonPayments,o.horizonKongNet,o.fullRemainingGross].every(Number.isFinite)
          ||o.horizonGross<0||o.horizonGross>o.fullRemainingGross
          ||o.horizonNet!==o.horizonGross-o.horizonPayments+o.horizonKongNet)throw new Error('Calibration accounting mismatch')
      }
    }
    rows.push(...data)
  }
  return {tag,metadata,rows,elapsedSeconds:done.elapsedSeconds}
})
if(settings.size!==1)throw new Error('Different source or policy configurations')
if(new Set(batches.map(b=>b.metadata.panel)).size!==batches.length)throw new Error('Use one completed batch per profile; do not mix pilot and formal samples')
const profiles=batches.map(b=>({tag:b.tag,panel:b.metadata.panel,from:b.metadata.from,seeds:b.metadata.seeds,
  elapsedSeconds:b.elapsedSeconds,currentMatches:b.rows.length,controlMatches:b.rows.length,
  delta:summary(b.rows,r=>r.delta),currentNet:summary(b.rows,r=>r.currentNet),controlNet:summary(b.rows,r=>r.controlNet),
  firstPlaceDelta:summary(b.rows,r=>Number(r.currentRank===1)-Number(r.controlRank===1)),rankDelta:summary(b.rows,r=>r.currentRank-r.controlRank),
  changedMatches:b.rows.filter(r=>r.changed).length,
  best:[...b.rows].sort((a,c)=>c.delta-a.delta).slice(0,3).map(r=>({seed:r.seed,focal:r.focal,delta:r.delta})),
  worst:[...b.rows].sort((a,c)=>a.delta-c.delta).slice(0,3).map(r=>({seed:r.seed,focal:r.focal,delta:r.delta}))}))

const observations=batches.flatMap(b=>b.rows.flatMap(r=>r.calibration.map(o=>({...o,
  split:o.seed<b.metadata.from+Math.floor(b.metadata.seeds/2)?'train':'holdout'}))))
const train=observations.filter(o=>o.split==='train'),holdout=observations.filter(o=>o.split==='holdout')
const denominator=train.reduce((s,o)=>s+o.predictedChain**2,0)
const scale=denominator?Math.max(0,train.reduce((s,o)=>s+o.predictedChain*o.horizonGross,0)/denominator):null
const constant=mean(train.map(o=>o.horizonGross))
function errors(rows,predict){
  return {windows:rows.length,mae:mean(rows.map(o=>Math.abs(predict(o)-o.horizonGross))),
    rmse:rows.length?Math.sqrt(mean(rows.map(o=>(predict(o)-o.horizonGross)**2))):null,
    meanPrediction:mean(rows.map(predict)),meanObserved:mean(rows.map(o=>o.horizonGross))}
}
const calibration=scale===null||constant===null||!holdout.length?{available:false,train:train.length,holdout:holdout.length}:{
  available:true,target:'Subsequent gross win income before the ninth own draw (including replacements) or round end; initial win excluded.',
  fitting:'Nonnegative through-origin OLS on first half of SOURCE SEEDS per profile. Remaining seeds never used in fit.',
  scale,constantPrediction:constant,trainWindows:train.length,holdoutWindows:holdout.length,
  trainSourceSeeds:new Set(train.map(o=>`${o.panel}/${o.seed}`)).size,
  holdoutSourceSeeds:new Set(holdout.map(o=>`${o.panel}/${o.seed}`)).size,
  holdoutRaw:errors(holdout,o=>o.predictedChain),holdoutScaled:errors(holdout,o=>scale*o.predictedChain),
  holdoutConstant:errors(holdout,()=>constant),
  rawMinusScaledAbsoluteError:summary(holdout,o=>Math.abs(o.predictedChain-o.horizonGross)-Math.abs(scale*o.predictedChain-o.horizonGross)),
  constantMinusScaledAbsoluteError:summary(holdout,o=>Math.abs(constant-o.horizonGross)-Math.abs(scale*o.predictedChain-o.horizonGross)),
  byProfile:Object.fromEntries([...new Set(holdout.map(o=>o.panel))].map(panel=>[panel,{
    raw:errors(holdout.filter(o=>o.panel===panel),o=>o.predictedChain),scaled:errors(holdout.filter(o=>o.panel===panel),o=>scale*o.predictedChain)}])),
  byStage:Object.fromEntries(['early','mid','late'].map(stage=>[stage,{
    raw:errors(holdout.filter(o=>o.stage===stage),o=>o.predictedChain),scaled:errors(holdout.filter(o=>o.stage===stage),o=>scale*o.predictedChain)}])),
  leaveOneProfileOut:Object.fromEntries([...new Set(holdout.map(o=>o.panel))].map(panel=>{
    const fit=train.filter(o=>o.panel!==panel),test=holdout.filter(o=>o.panel===panel)
    const denominator=fit.reduce((s,o)=>s+o.predictedChain**2,0)
    const factor=denominator?Math.max(0,fit.reduce((s,o)=>s+o.predictedChain*o.horizonGross,0)/denominator):null
    const constant=mean(fit.map(o=>o.horizonGross))
    return [panel,factor===null?{available:false}:{available:true,scale:factor,trainWindows:fit.length,
      raw:errors(test,o=>o.predictedChain),scaled:errors(test,o=>factor*o.predictedChain),constant:errors(test,()=>constant)}]
  })),
  caveat:'Accepted self-draw wins only; policy-dependent sample. Coefficient is an offline forecast calibration, not validated action-value correction or a deployable strength gain.',
  auditWindows:[...holdout].sort((a,b)=>Math.abs(scale*b.predictedChain-b.horizonGross)-Math.abs(scale*a.predictedChain-a.horizonGross)).slice(0,8),
}
const result={schema:1,tags,sourceFingerprint:batches[0].metadata.sourceFingerprint,apiRequests:0,
  sourceProfileSeeds:seen.size,currentMatches:batches.reduce((s,b)=>s+b.rows.length,0),controlMatches:batches.reduce((s,b)=>s+b.rows.length,0),
  profiles,calibration,observations,rows:batches.flatMap(b=>b.rows)}
const path=`work/blood-flow-opponent-panel/analysis-${tags.join('-')}.json`
writeFileSync(path,JSON.stringify(result,null,2))
console.log(JSON.stringify({path,profiles,calibration},null,2))
