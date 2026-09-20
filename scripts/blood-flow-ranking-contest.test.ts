import {it,expect} from 'vitest'
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {PANEL_CURRENT_CONFIG,panelPair,type PanelPair,type PanelId} from './blood-flow-opponent-panel'
import {clusterSummary} from './blood-flow-counterfactual'
import {rankingDecision} from './blood-flow-ranking-policy'
import {decideBloodFlowActionEv} from '../src/game/variants/lotus/bloodFlow/ai'
import type {BloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
function fingerprint(){
  const hash=createHash('sha256')
  const visit=(dir:string)=>{for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(dir,item.name);if(item.isDirectory())visit(path);else if(path.endsWith('.ts'))hash.update(path).update(readFileSync(path))
  }}
  visit('src/game')
  for(const name of ['ranking-policy','ranking-contest.test','opponent-panel','counterfactual'])hash.update(readFileSync(`scripts/blood-flow-${name}.ts`))
  return hash.digest('hex')
}
it.skipIf(process.env.BF_RANK_RUN!=='1')('compares frozen ranking policies on fresh complete matches',()=>{
  const mode=process.env.BF_RANK_MODE??'robust',panel=(process.env.BF_RANK_PANEL??'mixed') as PanelId
  const from=Number(process.env.BF_RANK_FROM??300001),seeds=Number(process.env.BF_RANK_SEEDS??8)
  if(!['raw','robust'].includes(mode)||!['mixed','defensive'].includes(panel)||!Number.isSafeInteger(from)||from<1||!Number.isSafeInteger(seeds)||seeds<1||seeds>64)throw new Error('Invalid run')
  const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'))
  const base={...PANEL_CURRENT_CONFIG,chainForecast:'source-v2' as const,reformGainRatio:1.2,
    opportunityCalibration:read('docs/blood-flow/records/opportunity-calibration-2026-09-20.json').calibration}
  const model=read('docs/blood-flow/records/conditional-ron-model-2026-09-20.json').model
  const ensemble=read('work/blood-flow-ranking/bootstrap.json').models
  const dir=`work/blood-flow-ranking/${mode}-${panel}-${from}`
  if(existsSync(dir))throw new Error('Fresh batch required')
  mkdirSync(dir,{recursive:true})
  const sourceFingerprint=fingerprint(),audit=new Map<string,unknown>(),start=Date.now()
  const metadata={mode,panel,from,seeds,base,model,sourceFingerprint,
    ensembleHash:createHash('sha256').update(JSON.stringify(ensemble)).digest('hex'),
    rule:'Ranking only, not win/claim gating. Robust needs training-bootstrap 5th percentile > 0 AND point-model relative gain >= 5%. The 5% deadband is engineering, not a return confidence interval.'}
  writeFileSync(`${dir}/metadata.json`,JSON.stringify(metadata,null,2))
  const control=(view:BloodFlowSeatView)=>decideBloodFlowActionEv(view,base)
  const candidate=(view:BloodFlowSeatView)=>{
    const result=rankingDecision(view,base,model,ensemble)
    if(result.eligible){
      const hash=createHash('sha256').update(JSON.stringify(view)).digest('hex')
      audit.set(hash,{roundId:view.roundId,seat:view.seat,wall:view.wallCount,...result})
    }
    return mode==='robust'?result.robust:result.raw
  }
  const rows:PanelPair[]=[]
  for(let seed=from;seed<from+seeds;seed++){
    const batch=([0,1,2,3] as const).map(seat=>panelPair(panel,seed,seat,4,true,candidate,control,false))
    rows.push(...batch);writeFileSync(`${dir}/seed-${seed}.json`,JSON.stringify(batch))
    writeFileSync(`${dir}/progress.json`,JSON.stringify({completed:seed-from+1,seeds,seconds:(Date.now()-start)/1000,eligibleWindows:audit.size}))
  }
  expect(fingerprint()).toBe(sourceFingerprint)
  writeFileSync(`${dir}/summary.json`,JSON.stringify({metadata,rows,audit:[...audit.values()],
    delta:clusterSummary(rows.map(r=>({seed:r.seed,value:r.delta}))),seconds:(Date.now()-start)/1000},null,2))
},7_200_000)
