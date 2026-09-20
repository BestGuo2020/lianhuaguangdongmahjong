import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
const [mode,...tags]=process.argv.slice(2)
if(!['fit','evaluate'].includes(mode)||!tags.length||tags.some(t=>!/^\d+$/.test(t)))throw new Error('Use fit/evaluate and completed batch starts')
const read=p=>JSON.parse(readFileSync(p,'utf8')),mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0
const fields=['gross','discardPaid','otherWinPaid','kongNet','immediateDiscardPaid','net']
const seen=new Set(),fingerprints=new Set(),evaluationFingerprints=new Set(),settings=new Set()
const batches=tags.map(tag=>{
  const dir=`work/blood-flow-paired/${tag}`,m=read(`${dir}/manifest.json`),data=read(`${dir}/outcomes-actual-draws-v2.json`),meta=read(`${dir}/metadata.json`)
  if(data.version!=='actual-draws-v2')throw new Error('Wrong horizon version')
  evaluationFingerprints.add(data.evaluationFingerprint)
  if(JSON.stringify(m)!==JSON.stringify(data.manifest)||m.fingerprint!==meta.fingerprint)throw new Error('Manifest/source mismatch')
  fingerprints.add(m.fingerprint);settings.add(JSON.stringify([meta.base,meta.model]))
  if(data.rows.length!==m.windows.length)throw new Error('Incomplete labels')
  for(const row of data.rows){
    const seed=row.plan.seed
    if(seen.has(seed))throw new Error('Duplicate source');seen.add(seed)
    if(row.checkpointHash!==m.windows.find(w=>w.seed===seed)?.checkpointHash||row.samples.length!==9)throw new Error('Invalid checkpoint/samples')
    if(new Set(row.samples.map(s=>s.sample)).size!==9||!row.samples.some(s=>s.sample===-1))throw new Error('Missing original/paired worlds')
    for(const s of row.samples)for(const arm of ['old','proposed'])for(const period of ['horizon','full']){
      const r=s[arm][period]
      if(r.net!==r.gross-r.discardPaid-r.otherWinPaid+r.kongNet||r.immediateDiscardPaid>r.discardPaid)throw new Error('Ledger mismatch')
    }
  }
  return {metadata:meta,manifest:m,rows:data.rows}
})
if(fingerprints.size!==1||evaluationFingerprints.size!==1||settings.size!==1)throw new Error('Mixed collection/evaluation policies')
function period(row,samples,name){
  const old=Object.fromEntries(fields.map(f=>[f,mean(samples.map(s=>s.old[name][f]))]))
  const proposed=Object.fromEntries(fields.map(f=>[f,mean(samples.map(s=>s.proposed[name][f]))]))
  return {old,proposed,delta:Object.fromEntries(fields.map(f=>[f,proposed[f]-old[f]]))}
}
const rows=batches.flatMap(b=>b.rows.map(row=>({seed:row.plan.seed,seat:row.plan.seat,wall:row.plan.wall,
  old:row.plan.old,proposed:row.plan.proposed,predictedGrossGap:row.plan.predictedGrossGap,
  riskGap:row.plan.proposed.riskProxy-row.plan.old.riskProxy,
  original:{horizon:period(row,row.samples.filter(s=>s.sample===-1),'horizon'),full:period(row,row.samples.filter(s=>s.sample===-1),'full')},
  permuted:{horizon:period(row,row.samples.filter(s=>s.sample>=0),'horizon'),full:period(row,row.samples.filter(s=>s.sample>=0),'full')},
  samples:row.samples.map(s=>({sample:s.sample,horizonNetGap:s.proposed.horizon.net-s.old.horizon.net,fullNetGap:s.proposed.full.net-s.old.full.net,
    horizonDiscardGap:s.proposed.horizon.discardPaid-s.old.horizon.discardPaid})),
  immediateInvariant:['old','proposed'].every(arm=>new Set(row.samples.map(s=>s[arm].full.immediateDiscardPaid)).size===1)})))
if(!rows.length)throw new Error('No disagreement windows; do not fit a zero-sized cohort')
if(!rows.every(r=>r.immediateInvariant))throw new Error('Immediate payment changed under wall permutation; inspect the evaluator')
function stat(values){
  let state=912701;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296}
  const boot=Array.from({length:4000},()=>mean(values.map(()=>values[Math.floor(random()*values.length)]))).sort((a,b)=>a-b)
  return {sourceWindows:values.length,mean:mean(values),ci95:values.length>=2?[boot[99],boot[3899]]:null,min:Math.min(...values),max:Math.max(...values)}
}
const summary={windows:rows.length,scannedRounds:batches.reduce((n,b)=>n+b.manifest.rounds,0),
  originalHorizon:Object.fromEntries(fields.map(f=>[f,stat(rows.map(r=>r.original.horizon.delta[f]))])),
  permutedHorizon:Object.fromEntries(fields.map(f=>[f,stat(rows.map(r=>r.permuted.horizon.delta[f]))])),
  originalFull:stat(rows.map(r=>r.original.full.delta.net)),permutedFull:stat(rows.map(r=>r.permuted.full.delta.net)),
  predictedGrossGap:stat(rows.map(r=>r.predictedGrossGap)),riskGap:stat(rows.map(r=>r.riskGap)),
  immediateInvariant:rows.every(r=>r.immediateInvariant)}
function slope(pairs){
  const denominator=pairs.reduce((n,[x])=>n+x*x,0),numerator=pairs.reduce((n,[x,y])=>n+x*y,0)
  return {value:denominator?Math.max(0,numerator/denominator):null,denominator,
    varyingFeatures:pairs.filter(([x])=>x!==0).length,nonzeroLabels:pairs.filter(([,y])=>y!==0).length,
    boundary:denominator>0&&numerator<=0}
}
const out='work/blood-flow-paired'
if(mode==='fit'){
  if(existsSync(`${out}/risk-scale.json`))throw new Error('Risk scale already frozen; no post-holdout refit')
  const immediate=slope(rows.flatMap(r=>[[r.old.riskProxy,r.original.horizon.old.immediateDiscardPaid],[r.proposed.riskProxy,r.original.horizon.proposed.immediateDiscardPaid]]))
  const horizonDiscard=slope(rows.map(r=>[r.riskGap,r.permuted.horizon.delta.discardPaid]))
  writeFileSync(`${out}/risk-scale.json`,JSON.stringify({trainTags:tags,fingerprint:[...fingerprints][0],evaluationFingerprint:[...evaluationFingerprints][0],immediate,horizonDiscard,
    scope:'Nonnegative through-origin OLS. Immediate uses two candidate arms per source, not repeated wall labels. Horizon scale maps proxy DIFFERENCES to mean paired 8-own-draw discard-payment DIFFERENCES. Partial net omits other payments and kong delta. No runtime policy change.',summary,rows},null,2))
  console.log(JSON.stringify({immediate,horizonDiscard,summary},null,2))
}else{
  const bytes=readFileSync(`${out}/risk-scale.json`),model=JSON.parse(bytes),modelHash=createHash('sha256').update(bytes).digest('hex')
  if(model.fingerprint!==[...fingerprints][0]||model.evaluationFingerprint!==[...evaluationFingerprints][0]||model.rows.some(t=>seen.has(t.seed)))throw new Error('Train/holdout mismatch or overlap')
  const mae=(x,y)=>mean(rows.map(r=>Math.abs(x(r)-y(r))))
  const k=model.horizonDiscard.value,im=model.immediate.value
  const trainImmediateMean=mean(model.rows.flatMap(r=>[r.original.horizon.old.immediateDiscardPaid,r.original.horizon.proposed.immediateDiscardPaid]))
  const immediateErrors=prediction=>rows.flatMap(r=>['old','proposed'].map(arm=>prediction(r,arm)-r.original.horizon[arm].immediateDiscardPaid))
  const immediateStats=prediction=>{
    const errors=immediateErrors(prediction)
    return {mae:mean(errors.map(Math.abs)),rmse:Math.sqrt(mean(errors.map(e=>e*e))),bias:mean(errors)}
  }
  const target=r=>r.permuted.horizon.delta.discardPaid
  const evaluation={discardCost:{zeroDifferenceMAE:mae(()=>0,target),rawProxyMAE:mae(r=>r.riskGap,target),
    calibratedMAE:k===null?null:mae(r=>k*r.riskGap,target),
    maeGain:k===null?null:stat(rows.map(r=>Math.abs(r.riskGap-target(r))-Math.abs(k*r.riskGap-target(r))))},
    immediate:{rawMAE:mean(rows.flatMap(r=>[Math.abs(r.old.riskProxy-r.original.horizon.old.immediateDiscardPaid),Math.abs(r.proposed.riskProxy-r.original.horizon.proposed.immediateDiscardPaid)])),
      calibratedMAE:im===null?null:mean(rows.flatMap(r=>[Math.abs(im*r.old.riskProxy-r.original.horizon.old.immediateDiscardPaid),Math.abs(im*r.proposed.riskProxy-r.original.horizon.proposed.immediateDiscardPaid)])),
      zero:immediateStats(()=>0),trainConstant:{value:trainImmediateMean,...immediateStats(()=>trainImmediateMean)},
      raw:immediateStats((r,arm)=>r[arm].riskProxy),calibrated:im===null?null:immediateStats((r,arm)=>im*r[arm].riskProxy),
      mseGainVsZero:im===null?null:stat(rows.map(r=>mean(['old','proposed'].map(arm=>{
        const y=r.original.horizon[arm].immediateDiscardPaid,p=im*r[arm].riskProxy
        return y*y-(p-y)**2
      }))))},
    omittedNetComponents:stat(rows.map(r=>-r.permuted.horizon.delta.otherWinPaid+r.permuted.horizon.delta.kongNet)),
    partialNetMAE:k===null?null:mae(r=>r.predictedGrossGap-k*r.riskGap,r=>r.permuted.horizon.delta.gross-r.permuted.horizon.delta.discardPaid),
    fullNetMAE:k===null?null:mae(r=>r.predictedGrossGap-k*r.riskGap,r=>r.permuted.horizon.delta.net),
    grossOnlyFullNetMAE:mae(r=>r.predictedGrossGap,r=>r.permuted.horizon.delta.net),
    shadow:k===null?null:{switched:rows.filter(r=>r.predictedGrossGap-k*r.riskGap<=0).length,
      meanNetVsOld:stat(rows.map(r=>r.predictedGrossGap-k*r.riskGap>0?r.permuted.horizon.delta.net:0)),
      meanNetVsAlwaysNew:stat(rows.map(r=>r.predictedGrossGap-k*r.riskGap>0?0:-r.permuted.horizon.delta.net))}}
  if(createHash('sha256').update(readFileSync(`${out}/risk-scale.json`)).digest('hex')!==modelHash)throw new Error('Model changed')
  writeFileSync(`${out}/holdout-analysis.json`,JSON.stringify({tags,modelHash,coefficients:{immediate:model.immediate,horizonDiscard:model.horizonDiscard},summary,evaluation,rows},null,2))
  console.log(JSON.stringify({summary,evaluation},null,2))
}
