import {readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {BLOOD_FLOW_AI,BLOOD_FLOW_CONFIG,BLOOD_FLOW_ACTION_PRIORITY,type BloodFlowAiConfig} from '../src/game/variants/lotus/bloodFlow/config'
import {decideBloodFlowActionEv} from '../src/game/variants/lotus/bloodFlow/ai'
import {ATTACK_CONFIG,DEFENSIVE_CONFIG,type PanelId} from './blood-flow-opponent-panel'
export const ACCEPTANCE_DIR='work/source-v2-final'
export const PANELS:PanelId[]=['legacy','attack','defensive','mixed']
export const CONTROL:BloodFlowAiConfig=Object.freeze({...BLOOD_FLOW_AI,chainForecast:'legacy',opportunityCalibration:undefined})
export const CANDIDATE:BloodFlowAiConfig=Object.freeze({...CONTROL,chainForecast:'source-v2',reformGainRatio:1.2,
  opportunityCalibration:JSON.parse(readFileSync('docs/blood-flow/records/opportunity-calibration-2026-09-20.json','utf8')).calibration})
export const controlPolicy=(view:Parameters<typeof decideBloodFlowActionEv>[0])=>decideBloodFlowActionEv(view,CONTROL)
export const candidatePolicy=(view:Parameters<typeof decideBloodFlowActionEv>[0])=>decideBloodFlowActionEv(view,CANDIDATE)
export function acceptanceFingerprint(){
  const h=createHash('sha256')
  const visit=(dir:string)=>{for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(dir,e.name);if(e.isDirectory())visit(path);else if(path.endsWith('.ts'))h.update(path.replaceAll('\\','/')).update(readFileSync(path))
  }}
  visit('src/game')
  for(const name of ['final-acceptance','final-acceptance.test','counterfactual','opponent-panel'])h.update(readFileSync(`scripts/blood-flow-${name}.ts`))
  h.update(readFileSync('docs/blood-flow/records/opportunity-calibration-2026-09-20.json'))
  return h.digest('hex')
}
export function acceptanceProtocol(){
  return {version:1,baselineCommit:'728ed400a952802474791ebe8788d4c0e1844917',fingerprint:acceptanceFingerprint(),
    control:CONTROL,candidate:CANDIDATE,rules:BLOOD_FLOW_CONFIG,actionPriority:BLOOD_FLOW_ACTION_PRIORITY,
    opponents:{legacy:'Existing heuristic, minimum first payment 0',attack:ATTACK_CONFIG,defensive:DEFENSIVE_CONFIG,mixed:'Existing seed-rotated mixture'},
    matches:PANELS.map((panel,i)=>({panel,seeds:Array.from({length:64},(_,n)=>4100001+i*1000+n)})),
    engineering:{warmupSeeds:[4300001,4300002,4300003,4300004],
      seeds:Array.from({length:16},(_,i)=>({seed:4200001+i,panel:PANELS[Math.floor(i/4)],focal:i%4,dealer:Math.floor(i/4)})),
      repetitions:3,p95RatioLimit:1.5,
      method:'Three predeclared SERIAL fresh Node runs. Warm up on four disjoint seeds, then clear forecast/wait caches. Generate formal and candidate trajectories on 16 matched new deals. Time both policies on each unique public focal view, alternating call order (and reversing parity between repeats). Exclude view construction, hashing and engine submit from timers. P95 nearest-rank per policy; gate is median of three paired P95 ratios. No selected worst-case windows, no reruns except identified tool errors.'},
    thresholds:{meanNetGainMin:50,meanNetGainCI95LowerGreaterThan:0,firstPlacePointDeltaMin:0,firstPlaceCI95LowerMin:-.02,
      severeLossNetAtMost:-1000,severeLossRateIncreaseMax:.01},
    inference:'256 independent source seeds stratified equally across four profiles; four focal seats per source and four rounds with carried scores. Paired source-seed bootstrap, 10000 replicates, fixed RNG seed 912701. Ties count as first place, consistent with the existing harness.',
    stopping:'Correctness or latency failure => reject and stop before payoff matches. Otherwise run all 256 seeds once. Any unmet/uncertain required threshold => reject, keep formal default, archive. No parameter/opponent/sample/metric changes to chase acceptance. Only an evidenced test-tool error permits a documented rerun.'}
}
export function assertAcceptanceFrozen(){
  const p=JSON.parse(readFileSync(`${ACCEPTANCE_DIR}/protocol.json`,'utf8'))
  if(p.fingerprint!==acceptanceFingerprint()||JSON.stringify(p.control)!==JSON.stringify(CONTROL)||JSON.stringify(p.candidate)!==JSON.stringify(CANDIDATE))throw new Error('Frozen source/config changed')
  return p
}
