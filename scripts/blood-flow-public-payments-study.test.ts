import {it,expect} from 'vitest'
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {candidatePublicFeatures,IMMEDIATE_FEATURES,PAIR_FEATURES} from './blood-flow-payment-public-features'
import {fitRidge,predictRidge} from './blood-flow-payment-ridge'
import {clusterSummary} from './blood-flow-counterfactual'
const out='work/blood-flow-public-payments'
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'))
const mean=(values:number[])=>values.length?values.reduce((a,b)=>a+b,0)/values.length:0
const fingerprint=()=>{
  const hash=createHash('sha256')
  for(const file of ['payment-public-features','payment-ridge','public-payments-study.test'])hash.update(readFileSync(`scripts/blood-flow-${file}.ts`))
  return hash.digest('hex')
}
function data(tags:number[]){
  const rows:any[]=[],seen=new Set<number>(),versions=new Set<string>()
  for(const tag of tags){
    const dir=`work/blood-flow-paired/${tag}`,result=read(`${dir}/outcomes-actual-draws-v2.json`),manifest=read(`${dir}/manifest.json`)
    expect(result.manifest).toEqual(manifest);expect(result.version).toBe('actual-draws-v2')
    versions.add(`${manifest.fingerprint}/${result.evaluationFingerprint}`)
    expect(result.rows.length).toBe(manifest.windows.length)
    for(const row of result.rows){
      const p=row.plan;if(seen.has(p.seed))throw new Error('Repeated source seed');seen.add(p.seed)
      expect(row.checkpointHash).toBe(manifest.windows.find((w:any)=>w.seed===p.seed)?.checkpointHash)
      expect(row.samples.map((s:any)=>s.sample).sort((a:number,b:number)=>a-b)).toEqual([-1,0,1,2,3,4,5,6,7])
      const old=candidatePublicFeatures(p.view,p.old.index),proposed=candidatePublicFeatures(p.view,p.proposed.index)
      expect(old.grossH8).toBeCloseTo(p.old.grossPrediction,7);expect(proposed.grossH8).toBeCloseTo(p.proposed.grossPrediction,7)
      const labels=(samples:any[])=>{
        const arm=(key:string)=>{
          const values=samples.map(s=>{
            const h=s[key].horizon,f=s[key].full
            expect(h.net).toBe(h.gross-h.discardPaid-h.otherWinPaid+h.kongNet)
            expect(f.net).toBe(f.gross-f.discardPaid-f.otherWinPaid+f.kongNet)
            return {immediate:h.immediateDiscardPaid,later:h.discardPaid-h.immediateDiscardPaid+h.otherWinPaid,
              tail:f.net-h.net,gross:h.gross,kong:h.kongNet,horizon:h.net,full:f.net}
          })
          return Object.fromEntries(Object.keys(values[0]).map(k=>[k,mean(values.map(v=>v[k]))]))
        }
        const old=arm('old'),proposed=arm('proposed')
        return {old,proposed,delta:Object.fromEntries(Object.keys(old).map(k=>[k,proposed[k]-old[k]]))}
      }
      const original=labels(row.samples.filter((s:any)=>s.sample===-1)),permuted=labels(row.samples.filter((s:any)=>s.sample>=0))
      expect(new Set(row.samples.map((s:any)=>s.old.full.immediateDiscardPaid)).size).toBe(1)
      expect(new Set(row.samples.map((s:any)=>s.proposed.full.immediateDiscardPaid)).size).toBe(1)
      rows.push({seed:p.seed,seat:p.seat,wall:p.wall,old,proposed,dx:proposed.paired.map((v:number,i:number)=>v-old.paired[i]),
        tailDx:proposed.tailPaired.map((v:number,i:number)=>v-old.tailPaired[i]),original,permuted})
    }
  }
  expect(versions.size).toBe(1)
  if(rows.length<8)throw new Error('Apply prespecified sample expansion before fitting/evaluation')
  return {rows,version:[...versions][0]}
}
it.skipIf(process.env.BF_PAY_FIT!=='1')('freezes three independent targets using only new training windows',()=>{
  if(existsSync(`${out}/models.json`))throw new Error('Models already frozen')
  const tags=[320001,320129],{rows,version}=data(tags)
  const immediateX=rows.flatMap(r=>[r.old.immediate,r.proposed.immediate]),immediateY=rows.flatMap(r=>[r.original.old.immediate,r.original.proposed.immediate])
  const denominator=rows.reduce((s,r)=>s+r.old.riskProxy**2+r.proposed.riskProxy**2,0)
  const numerator=rows.reduce((s,r)=>s+r.old.riskProxy*r.original.old.immediate+r.proposed.riskProxy*r.original.proposed.immediate,0)
  const model={tags,version,fingerprint:fingerprint(),featureNames:{immediate:IMMEDIATE_FEATURES,paired:PAIR_FEATURES},
    immediate:fitRidge(immediateX,immediateY,false),later:fitRidge(rows.map(r=>r.dx),rows.map(r=>r.permuted.delta.later),true),
    tail:fitRidge(rows.map(r=>r.tailDx),rows.map(r=>r.permuted.delta.tail),true),
    scalar:denominator?Math.max(0,numerator/denominator):null,constant:mean(immediateY),
    oldScalar:read('docs/blood-flow/records/paired-window-risk-scale-2026-09-20.json').immediate.value,
    positiveImmediateLabels:immediateY.filter(v=>v>0).length,tailWindows:rows.filter(r=>r.permuted.old.tail!==0||r.permuted.proposed.tail!==0).length,rows}
  mkdirSync(out,{recursive:true});writeFileSync(`${out}/models.json`,JSON.stringify(model,null,2))
},300_000)
it.skipIf(process.env.BF_PAY_EVAL!=='1')('compares frozen public features, later payments and tail value on new held-out windows',()=>{
  const bytes=readFileSync(`${out}/models.json`),model=JSON.parse(bytes.toString()),hash=createHash('sha256').update(bytes).digest('hex')
  expect(fingerprint()).toBe(model.fingerprint)
  const tags=[321001,321129],{rows,version}=data(tags);expect(version).toBe(model.version)
  expect(rows.some(r=>model.rows.some((t:any)=>t.seed===r.seed))).toBe(false)
  for(const r of rows){
    const oldImmediate=predictRidge(model.immediate,r.old.immediate),newImmediate=predictRidge(model.immediate,r.proposed.immediate)
    const later=predictRidge(model.later,r.dx),tail=predictRidge(model.tail,r.tailDx),gross=r.proposed.grossH8-r.old.grossH8
    r.prediction={oldImmediate,newImmediate,immediateGap:newImmediate-oldImmediate,later,tail,gross,
      tailProxy:r.proposed.tailGross-r.old.tailGross,netH8:gross-(newImmediate-oldImmediate)-later,
      netFull:gross-(newImmediate-oldImmediate)-later+tail}
  }
  const metric=(errors:number[])=>({mae:mean(errors.map(Math.abs)),rmse:Math.sqrt(mean(errors.map(e=>e*e))),bias:mean(errors)})
  const ci=(f:(r:any)=>number)=>clusterSummary(rows.map(r=>({seed:r.seed,value:f(r)})))
  const immediateMetric=(f:(r:any,key:'old'|'proposed')=>number)=>metric(rows.flatMap(r=>(['old','proposed'] as const).map(key=>f(r,key)-r.original[key].immediate)))
  const pairedMetrics=(target:string,predict:(r:any)=>number)=>({
    zero:metric(rows.map(r=>-r.permuted.delta[target])),model:metric(rows.map(r=>predict(r)-r.permuted.delta[target])),
    originalZero:metric(rows.map(r=>-r.original.delta[target])),originalModel:metric(rows.map(r=>predict(r)-r.original.delta[target])),
    maeGain:ci(r=>Math.abs(r.permuted.delta[target])-Math.abs(predict(r)-r.permuted.delta[target])),
    actualMean:ci(r=>r.permuted.delta[target])})
  const result={tags,modelHash:hash,sourceWindows:rows.length,
    immediate:{zero:immediateMetric(()=>0),constant:immediateMetric(()=>model.constant),
      frozenScalar:immediateMetric((r,key)=>model.oldScalar*r[key].riskProxy),newScalar:model.scalar===null?null:immediateMetric((r,key)=>model.scalar*r[key].riskProxy),
      publicFeatures:immediateMetric((r,key)=>key==='old'?r.prediction.oldImmediate:r.prediction.newImmediate),
      maeGainVsFrozen:ci(r=>mean((['old','proposed'] as const).map(key=>Math.abs(model.oldScalar*r[key].riskProxy-r.original[key].immediate)
        -Math.abs((key==='old'?r.prediction.oldImmediate:r.prediction.newImmediate)-r.original[key].immediate)))),
      mseGainVsFrozen:ci(r=>mean((['old','proposed'] as const).map(key=>(model.oldScalar*r[key].riskProxy-r.original[key].immediate)**2
        -((key==='old'?r.prediction.oldImmediate:r.prediction.newImmediate)-r.original[key].immediate)**2)))},
    later:pairedMetrics('later',r=>r.prediction.later),tail:pairedMetrics('tail',r=>r.prediction.tail),
    tailProxy:metric(rows.map(r=>r.prediction.tailProxy-r.permuted.delta.tail)),
    combined:{grossOnly:metric(rows.map(r=>r.prediction.gross-r.permuted.delta.full)),
      withPublicComponents:metric(rows.map(r=>r.prediction.netFull-r.permuted.delta.full)),
      omittedH8Kong:ci(r=>r.permuted.delta.kong),changedWindows:rows.filter(r=>r.prediction.netFull<=0).length,
      shadowVsOld:ci(r=>r.prediction.netFull>0?r.permuted.delta.full:0),
      shadowVsAlwaysNew:ci(r=>r.prediction.netFull>0?0:-r.permuted.delta.full),
      originalShadowVsOld:ci(r=>r.prediction.netFull>0?r.original.delta.full:0)},rows}
  expect(createHash('sha256').update(readFileSync(`${out}/models.json`)).digest('hex')).toBe(hash)
  writeFileSync(`${out}/holdout.json`,JSON.stringify(result,null,2))
},300_000)
