import {it,expect} from 'vitest'
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {RON_CATEGORIES,type CategoryVector,type ConditionalRonModel} from '../src/game/variants/lotus/bloodFlow/conditionalRon'
import {seededRandom} from '../src/game/variants/lotus/bloodFlow/simulation'
const uniform={'wildcard-face':1,honor:1,terminal:1,middle:1}
const sum=(rows:any[],f:(r:any)=>number)=>rows.reduce((n,r)=>n+f(r),0)
function probabilities(prior:CategoryVector,w:CategoryVector){
  const total=RON_CATEGORIES.reduce((n,c)=>n+prior[c]*w[c],0)
  return Object.fromEntries(RON_CATEGORIES.map(c=>[c,total?prior[c]*w[c]/total:0])) as CategoryVector
}
function fit(rows:any[],parent:CategoryVector){
  const prior=Object.fromEntries(RON_CATEGORIES.map(c=>[c,sum(rows,r=>r.categoryProbabilities[c])/rows.length])) as CategoryVector
  const parentP=probabilities(prior,parent),w={...parent}
  const target=Object.fromEntries(RON_CATEGORIES.map(c=>[c,rows.filter(r=>r.category===c).length+64*parentP[c]])) as CategoryVector
  for(let i=0;i<200;i++){
    const p=rows.map(r=>probabilities(r.categoryProbabilities,w)),pseudo=probabilities(prior,w)
    for(const c of RON_CATEGORIES){const expected=sum(p,r=>r[c])+64*pseudo[c];if(expected)w[c]*=target[c]/expected}
    const scale=Math.max(...Object.values(w));for(const c of RON_CATEGORIES)w[c]/=scale
  }
  return w
}
function modelFor(rows:any[]):ConditionalRonModel{
  const weights:Record<string,CategoryVector>={global:fit(rows,uniform)}
  for(const locked of [false,true]){
    const subset=rows.filter(r=>r.opponentLocked===locked)
    weights[String(locked)]=fit(subset,weights.global)
    for(const band of ['no-live-ron','low-1-40','mid-40-160','high-over-160']){
      const cell=subset.filter(r=>r.valueBand===band)
      if(new Set(cell.map(r=>r.seed)).size>=8)weights[`${locked}/${band}`]=fit(cell,weights[String(locked)])
    }
  }
  return {version:1,weights}
}
it.skipIf(process.env.BF_RANK_BOOT!=='1')('resamples training source games only, preserving the frozen fitting procedure',()=>{
  const path='work/blood-flow-ranking/bootstrap.json'
  if(existsSync(path))throw new Error('Bootstrap already frozen')
  const groups:any[][]=[]
  for(const [panel,from] of [['mixed',290001],['defensive',290101]] as const){
    const dir=`work/blood-flow-ron/${panel}-${from}`
    const done=JSON.parse(readFileSync(`${dir}/done.json`,'utf8'));expect(done.rounds).toBe(32)
    for(let seed=from;seed<from+32;seed++)groups.push(JSON.parse(readFileSync(`${dir}/seed-${seed}.json`,'utf8')))
  }
  const frozen=JSON.parse(readFileSync('docs/blood-flow/records/conditional-ron-model-2026-09-20.json','utf8')).model
  const reference=modelFor(groups.flat())
  expect(reference).toEqual(frozen)
  const random=seededRandom(300019),models:ConditionalRonModel[]=[]
  mkdirSync('work/blood-flow-ranking',{recursive:true})
  for(let b=0;b<64;b++){
    models.push(modelFor(Array.from({length:groups.length},()=>groups[Math.floor(random()*groups.length)]).flat()))
    writeFileSync('work/blood-flow-ranking/bootstrap-progress.json',JSON.stringify({completed:b+1,total:64}))
  }
  writeFileSync(path,JSON.stringify({scope:'Parameter resampling only; not future-wall uncertainty or a calibrated return confidence interval. Original training source seeds including empty games; no held-out labels.',models},null,2))
},300_000)
