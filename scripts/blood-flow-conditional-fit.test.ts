import {it,expect} from 'vitest'
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {RON_CATEGORIES,conditionalCategoryProbabilities,type CategoryVector,type ConditionalRonModel} from '../src/game/variants/lotus/bloodFlow/conditionalRon'
import {clusterSummary} from './blood-flow-counterfactual'
const dir='work/blood-flow-conditional'
const uniform={ 'wildcard-face':1,honor:1,terminal:1,middle:1 }
function load(tags:string[]) {
  const seen=new Set<number>()
  return tags.flatMap(tag=>{
    const path=`work/blood-flow-ron/${tag}`,m=JSON.parse(readFileSync(`${path}/done.json`,'utf8'))
    return Array.from({length:m.rounds},(_,i)=>{
      const seed=m.from+i;if(seen.has(seed))throw new Error('Duplicate seed');seen.add(seed)
      const rows=JSON.parse(readFileSync(`${path}/seed-${seed}.json`,'utf8'))
      for(const r of rows)if(r.seed!==seed||!r.categoryValues)throw new Error('Invalid features')
      return rows
    }).flat()
  })
}
const sum=(rows:any[],f:(r:any)=>number)=>rows.reduce((n,r)=>n+f(r),0)
const normalize=(prior:CategoryVector,w:CategoryVector)=>{
  const total=RON_CATEGORIES.reduce((n,c)=>n+prior[c]*w[c],0)
  return Object.fromEntries(RON_CATEGORIES.map(c=>[c,total?prior[c]*w[c]/total:0])) as Record<typeof RON_CATEGORIES[number],number>
}
/** Multinomial intercept fit with known per-observation available-mass offsets.
 * 64 pseudo exposures shrink to the parent. Hyperparameters fixed before labels. */
function fit(rows:any[],parent:CategoryVector) {
  const prior=Object.fromEntries(RON_CATEGORIES.map(c=>[c,sum(rows,r=>r.categoryProbabilities[c])/rows.length])) as CategoryVector
  const parentP=normalize(prior,parent),w={...parent}
  const target=Object.fromEntries(RON_CATEGORIES.map(c=>[c,rows.filter(r=>r.category===c).length+64*parentP[c]])) as CategoryVector
  for(let iteration=0;iteration<200;iteration++){
    const predictions=rows.map(r=>normalize(r.categoryProbabilities,w)),pseudo=normalize(prior,w)
    for(const c of RON_CATEGORIES){const expected=sum(predictions,r=>r[c])+64*pseudo[c];if(expected)w[c]*=target[c]/expected}
    const scale=Math.max(...Object.values(w));for(const c of RON_CATEGORIES)w[c]/=scale
  }
  return w
}
it.skipIf(process.env.BF_CONDITIONAL_FIT!=='1')('fits only new training categories then freezes the model',()=>{
  if(existsSync(`${dir}/model.json`))throw new Error('Model already frozen; do not refit after holdout')
  const tags=['mixed-290001','defensive-290101'],rows=load(tags)
  const weights:Record<string,CategoryVector>={global:fit(rows,uniform)},groups:any[]=[]
  for(const locked of [false,true]){
    const subset=rows.filter(r=>r.opponentLocked===locked)
    weights[String(locked)]=fit(subset,weights.global)
    for(const band of ['no-live-ron','low-1-40','mid-40-160','high-over-160']){
      const cell=subset.filter(r=>r.valueBand===band),seeds=new Set(cell.map(r=>r.seed)).size,key=`${locked}/${band}`
      if(seeds>=8)weights[key]=fit(cell,weights[String(locked)])
      groups.push({key,observations:cell.length,seeds,fallback:seeds<8})
    }
  }
  const model:ConditionalRonModel={version:1,weights}
  expect(Object.values(weights).flatMap(Object.values).every(v=>Number.isFinite(v)&&v>=0)).toBe(true)
  mkdirSync(dir,{recursive:true})
  const result={model,tags,observations:rows.length,sourceSeeds:new Set(rows.map(r=>r.seed)).size,groups,
    protocol:'Train category labels only; 200 fixed proportional-fit steps; 64 parent pseudo exposures; cells need 8 source seeds. No income fitting. Fixed source-v2 coefficients, ratio 1.2. Holdout not loaded.'}
  writeFileSync(`${dir}/model.json`,JSON.stringify(result,null,2))
},120_000)

it.skipIf(process.env.BF_CONDITIONAL_EVAL!=='1')('compares the frozen model on untouched source games',()=>{
  const bytes=readFileSync(`${dir}/model.json`),artifact=JSON.parse(bytes.toString()),model=artifact.model as ConditionalRonModel
  const hash=createHash('sha256').update(bytes).digest('hex'),tags=['mixed-291001','defensive-291101'],rows=load(tags)
  const calibration=JSON.parse(readFileSync('docs/blood-flow/records/opportunity-calibration-2026-09-20.json','utf8')).calibration
  for(const r of rows){
    const p=conditionalCategoryProbabilities(r.categoryProbabilities,r.opponentLocked,r.valueBand,model)
    r.newPrediction=RON_CATEGORIES.reduce((n,c)=>n+p[c]*r.categoryValues[c],0)*calibration.ronYield
    r.oldLogLoss=-Math.log(Math.max(1e-12,r.categoryProbabilities[r.category]))
    r.newLogLoss=-Math.log(Math.max(1e-12,p[r.category as typeof RON_CATEGORIES[number]]))
  }
  const metrics=(data:any[])=>{
    const mean=(f:(r:any)=>number)=>sum(data,f)/data.length
    return {observations:data.length,seeds:new Set(data.map(r=>r.seed)).size,actual:mean(r=>r.realized),
      oldMean:mean(r=>r.predicted),newMean:mean(r=>r.newPrediction),oldMAE:mean(r=>Math.abs(r.predicted-r.realized)),newMAE:mean(r=>Math.abs(r.newPrediction-r.realized)),
      oldRMSE:Math.sqrt(mean(r=>(r.predicted-r.realized)**2)),newRMSE:Math.sqrt(mean(r=>(r.newPrediction-r.realized)**2)),
      oldLogLoss:mean(r=>r.oldLogLoss),newLogLoss:mean(r=>r.newLogLoss),
      maeGain:clusterSummary(data.map(r=>({seed:r.seed,value:Math.abs(r.predicted-r.realized)-Math.abs(r.newPrediction-r.realized)}))),
      logLossGain:clusterSummary(data.map(r=>({seed:r.seed,value:r.oldLogLoss-r.newLogLoss})))}
  }
  expect(createHash('sha256').update(readFileSync(`${dir}/model.json`)).digest('hex')).toBe(hash)
  const result={modelHash:hash,tags,overall:metrics(rows),byLock:[false,true].map(locked=>({locked,...metrics(rows.filter(r=>r.opponentLocked===locked))})),
    byValue:[...new Set(rows.map(r=>r.valueBand))].map(valueBand=>({valueBand,...metrics(rows.filter(r=>r.valueBand===valueBand))})),
    rows:rows.map(({seed,opponentLocked,valueBand,category,predicted,newPrediction,realized,oldLogLoss,newLogLoss})=>({seed,opponentLocked,valueBand,category,predicted,newPrediction,realized,oldLogLoss,newLogLoss}))}
  writeFileSync(`${dir}/holdout.json`,JSON.stringify(result,null,2))
},120_000)
