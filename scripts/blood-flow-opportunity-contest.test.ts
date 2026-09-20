import { it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import { PANEL_CURRENT_CONFIG, panelPair, type PanelPair, type PanelId } from './blood-flow-opponent-panel'
import { clusterSummary } from './blood-flow-counterfactual'
import type { BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
function fingerprint(){
  const hash=createHash('sha256')
  const visit=(dir:string)=>{for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(dir,item.name);if(item.isDirectory())visit(path);else if(path.endsWith('.ts'))hash.update(path).update(readFileSync(path))
  }}
  visit('src/game');for(const file of ['blood-flow-opportunity-contest.test','blood-flow-opponent-panel','blood-flow-counterfactual'])hash.update(readFileSync(`scripts/${file}.ts`))
  return hash.digest('hex')
}
it.skipIf(process.env.BF_SOURCE_RUN!=='1')('tests a frozen source model and reform threshold',()=>{
  const ratio=Number(process.env.BF_SOURCE_RATIO??1.2),from=Number(process.env.BF_SOURCE_FROM??271001),seeds=Number(process.env.BF_SOURCE_SEEDS??4)
  const panel=(process.env.BF_SOURCE_PANEL??'mixed') as PanelId,mode=process.env.BF_SOURCE_MODE??'threshold'
  if(![1,1.2,1.5].includes(ratio)||!['mixed','defensive'].includes(panel)||!['threshold','production'].includes(mode)
    ||!Number.isSafeInteger(from)||from<1||!Number.isSafeInteger(seeds)||seeds<1||seeds>64)throw new Error('Invalid run')
  const calibration=JSON.parse(readFileSync('work/blood-flow-opportunity/calibration.json','utf8')).calibration
  const base={...PANEL_CURRENT_CONFIG,chainForecast:'source-v2' as const,opportunityCalibration:calibration}
  const candidateConfig={...base,reformGainRatio:ratio},controlConfig=mode==='threshold'?{...base,reformGainRatio:1.2}:PANEL_CURRENT_CONFIG
  const candidate=(view:BloodFlowSeatView)=>decideBloodFlowActionEv(view,candidateConfig)
  const control=(view:BloodFlowSeatView)=>decideBloodFlowActionEv(view,controlConfig)
  const dir=`work/blood-flow-opportunity/${mode}-${panel}-${ratio}-${from}`
  if(existsSync(dir))throw new Error('Fresh batch required')
  mkdirSync(dir,{recursive:true})
  const sourceFingerprint=fingerprint(),metadata={ratio,from,seeds,panel,mode,candidateConfig,controlConfig,sourceFingerprint}
  writeFileSync(`${dir}/metadata.json`,JSON.stringify(metadata,null,2))
  const rows:PanelPair[]=[],start=Date.now()
  for(let seed=from;seed<from+seeds;seed++){
    const batch=([0,1,2,3] as const).map(seat=>panelPair(panel,seed,seat,4,true,candidate,control,false))
    rows.push(...batch);writeFileSync(`${dir}/seed-${seed}.json`,JSON.stringify(batch))
    writeFileSync(`${dir}/progress.json`,JSON.stringify({completed:seed-from+1,seeds,seconds:(Date.now()-start)/1000}))
  }
  expect(fingerprint()).toBe(sourceFingerprint)
  const delta=clusterSummary(rows.map(r=>({seed:r.seed,value:r.delta})))
  writeFileSync(`${dir}/summary.json`,JSON.stringify({metadata,delta,rows,seconds:(Date.now()-start)/1000},null,2))
},7_200_000)
