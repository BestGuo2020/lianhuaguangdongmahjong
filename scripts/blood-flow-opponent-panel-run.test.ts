import { expect,it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BLOOD_FLOW_CONFIG,BLOOD_FLOW_ACTION_PRIORITY } from '../src/game/variants/lotus/bloodFlow/config'
import { clusterSummary } from './blood-flow-counterfactual'
import { panelPair,PANEL_CURRENT_CONFIG,PANEL_BASE_CONFIG,ATTACK_CONFIG,DEFENSIVE_CONFIG,type PanelId,type PanelPair } from './blood-flow-opponent-panel'

function fingerprint(){
  const files:string[]=[]
  const visit=(dir:string)=>{for(const item of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,item.name)
    if(item.isDirectory())visit(path);else if(item.name.endsWith('.ts'))files.push(path)
  }}
  visit('src/game')
  files.push('scripts/blood-flow-counterfactual.ts','scripts/blood-flow-opponent-panel.ts','scripts/blood-flow-opponent-panel-run.test.ts')
  const hash=createHash('sha256')
  for(const path of files.sort())hash.update(path.replaceAll('\\','/')).update('\0').update(readFileSync(path)).update('\0')
  return hash.digest('hex')
}
it.skipIf(process.env.BF_PANEL_RUN!=='1')('runs paired cross-opponent matches and passive calibration observations',()=>{
  const panel=(process.env.BF_PANEL_PROFILE??'mixed') as PanelId,tag=process.env.BF_PANEL_TAG??'pilot'
  const from=Number(process.env.BF_PANEL_FROM??1550001),seeds=Number(process.env.BF_PANEL_SEEDS??2)
  if(!['legacy','attack','defensive','mixed'].includes(panel)||!/^[a-zA-Z0-9_-]+$/.test(tag)
    ||!Number.isSafeInteger(from)||from<1||from>500_000_000||!Number.isSafeInteger(seeds)||seeds<1||seeds>1000)throw new Error('Invalid budget')
  const dir=`work/blood-flow-opponent-panel/${tag}`
  if(existsSync(`${dir}/metadata.json`))throw new Error('Use a fresh tag')
  mkdirSync(dir,{recursive:true})
  const started=Date.now(),sourceFingerprint=fingerprint()
  const metadata={tag,panel,from,seeds,roundsPerMatch:4,seatsPerSeed:4,sourceFingerprint,
    commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),apiRequests:0,
    current:PANEL_CURRENT_CONFIG,control:PANEL_BASE_CONFIG,attack:ATTACK_CONFIG,defensive:DEFENSIVE_CONFIG,
    ruleConfig:BLOOD_FLOW_CONFIG,actionPriority:BLOOD_FLOW_ACTION_PRIORITY,
    controlDescription:'Frozen pre-integration EV: all three recent switches off, unchanged other parameters.',
    opponentDescription:'Legacy heuristic; immediate-win/risk-off attacker; double-risk-price cautious EV; or seat-rotated mixture. These are synthetic profiles, not humans or independent trained experts.',
    protocol:'Same opponents and four seeded deals for focal control/current arms, four focal seats, scores carried. Absolute net is NOT equal to paired improvement against heterogeneous opponents.',
    calibration:'Current trajectory only; first actual unlocked self-draw win per round. Gross subsequent win income until before ninth own draw (including replacement draws) or round end. First-win income excluded. No observations from rejected actions.'}
  writeFileSync(`${dir}/metadata.json`,JSON.stringify(metadata,null,2))
  const rows:PanelPair[]=[]
  for(let seed=from;seed<from+seeds;seed++){
    const result:PanelPair[]=[]
    for(const focal of [0,1,2,3] as const)result.push(panelPair(panel,seed,focal))
    rows.push(...result)
    writeFileSync(`${dir}/seed-${seed}.json`,JSON.stringify(result,null,2))
    writeFileSync(`${dir}/progress.json`,JSON.stringify({completedSeeds:seed-from+1,currentMatches:rows.length,
      controlMatches:rows.length,changedMatches:rows.filter(r=>r.changed).length,calibrationWindows:rows.flatMap(r=>r.calibration).length,
      elapsedSeconds:(Date.now()-started)/1000}))
  }
  expect(fingerprint()).toBe(sourceFingerprint)
  const metric=(f:(row:PanelPair)=>number)=>clusterSummary(rows.map(r=>({seed:r.seed,value:f(r)})))
  writeFileSync(`${dir}/summary.json`,JSON.stringify({metadata,elapsedSeconds:(Date.now()-started)/1000,
    summary:{delta:metric(r=>r.delta),currentNet:metric(r=>r.currentNet),controlNet:metric(r=>r.controlNet),
      rankDelta:metric(r=>r.currentRank-r.controlRank),firstPlaceDelta:metric(r=>Number(r.currentRank===1)-Number(r.controlRank===1)),
      changedMatches:rows.filter(r=>r.changed).length,calibrationWindows:rows.flatMap(r=>r.calibration).length}},null,2))
},7_200_000)
