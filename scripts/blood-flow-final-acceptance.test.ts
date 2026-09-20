import {it,expect} from 'vitest'
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {cpus} from 'node:os'
import {BloodFlowEngine} from '../src/game/variants/lotus/bloodFlow/engine'
import {bloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
import {seededRandom} from '../src/game/variants/lotus/bloodFlow/simulation'
import type {Seat} from '../src/game/variants/lotus/bloodFlow/types'
import {nextSeatToAct,submit} from './blood-flow-counterfactual'
import {opponentFor,panelPair,type PanelPair,type PanelId} from './blood-flow-opponent-panel'
import {clearForecastCache} from '../src/game/variants/lotus/bloodFlow/incomeForecast'
import {clearWaitingCacheForDiagnostics} from '../src/game/variants/lotus/bloodFlow/patternPotentials'
import {ACCEPTANCE_DIR,PANELS,CONTROL,CANDIDATE,controlPolicy,candidatePolicy,acceptanceProtocol,assertAcceptanceFrozen} from './blood-flow-final-acceptance'

it.skipIf(process.env.BF_FINAL_INIT!=='1')('freezes the only candidate, gate and complete unseen seed list',()=>{
  if(existsSync(`${ACCEPTANCE_DIR}/protocol.json`))throw new Error('Protocol already frozen')
  expect(CONTROL.chainForecast).toBe('legacy');expect(CONTROL.reformGainRatio).toBe(1.2)
  expect(CONTROL.conditionalRon).toBeUndefined();expect(CANDIDATE.conditionalRon).toBeUndefined()
  mkdirSync(ACCEPTANCE_DIR,{recursive:true})
  writeFileSync(`${ACCEPTANCE_DIR}/protocol.json`,JSON.stringify(acceptanceProtocol(),null,2))
})

it.skipIf(process.env.BF_FINAL_ENGINEERING!=='1')('runs one predeclared paired engineering measurement',()=>{
  const protocol=assertAcceptanceFrozen(),rep=Number(process.env.BF_FINAL_REP??0)
  if(!Number.isInteger(rep)||rep<0||rep>=3)throw new Error('Invalid predeclared repeat')
  const path=`${ACCEPTANCE_DIR}/engineering-${rep}.json`
  if(existsSync(path))throw new Error('Engineering repeat already exists; no result-chasing rerun')
  const records:any[]=[],states=new Map<string,any>(),slow:any[]=[];let commands=0
  const trace=(seed:number,panel:PanelId,focal:Seat,dealer:Seat,arm:'control'|'candidate',measure:boolean)=>{
    const e=new BloodFlowEngine({authorityEpoch:'formal-gate',roundId:`${seed}`,dealer,random:seededRandom(seed),now:()=>0,winBeatMs:0,paced:false})
    let steps=0
    while(!e.result){
      if(++steps>2000)throw new Error('Engineering game stalled')
      const seat=nextSeatToAct(e),view=bloodFlowSeatView(e,seat)
      if(view.players.some((p,i)=>i!==seat&&p.hand.length))throw new Error('Hidden information leak')
      let action
      if(seat===focal&&measure){
        const input=JSON.stringify(view),key=createHash('sha256').update(input).digest('hex')
        let r=states.get(key)
        if(!r){
          r={seed,panel,focal,windowId:view.window?.id,kind:view.window?.kind,wall:view.wallCount,key}
          const order=(records.length+rep)%2===0?['control','candidate']:['candidate','control']
          for(const variant of order){
            const start=performance.now(),chosen=(variant==='control'?controlPolicy:candidatePolicy)(view),elapsed=performance.now()-start
            expect(view.ownActions).toContainEqual(chosen)
            r[`${variant}Ms`]=elapsed;r[variant]=chosen
          }
          expect(JSON.stringify(view)).toBe(input)
          states.set(key,r);records.push(r)
          slow.push({view,record:r});slow.sort((a,b)=>b.record.candidateMs-a.record.candidateMs);if(slow.length>5)slow.pop()
        }
        action=r[arm]
      }else action=(seat===focal?(arm==='control'?controlPolicy:candidatePolicy):opponentFor(panel,seed,focal,seat))(view)
      if(!action)throw new Error('Missing action')
      submit(e,seat,action);commands++
    }
    expect(e.players.reduce((n,p)=>n+p.score,0)).toBe(8000)
  }
  for(let i=0;i<4;i++)for(const arm of ['control','candidate'] as const)trace(protocol.engineering.warmupSeeds[i],PANELS[i],i as Seat,i as Seat,arm,false)
  clearForecastCache();clearWaitingCacheForDiagnostics()
  for(const c of protocol.engineering.seeds){
    for(const arm of (rep%2?['candidate','control']:['control','candidate']) as ('control'|'candidate')[])trace(c.seed,c.panel,c.focal,c.dealer,arm,true)
    writeFileSync(`${ACCEPTANCE_DIR}/engineering-progress-${rep}.json`,JSON.stringify({completedSeed:c.seed,uniqueDecisions:records.length}))
  }
  expect(records.length).toBeGreaterThanOrEqual(200)
  assertAcceptanceFrozen()
  const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]
  const controlP95=percentile(records.map(r=>r.controlMs),.95),candidateP95=percentile(records.map(r=>r.candidateMs),.95)
  writeFileSync(path,JSON.stringify({rep,fingerprint:protocol.fingerprint,node:process.version,platform:process.platform,cpu:cpus()[0]?.model,
    logicalCpus:cpus().length,uniqueDecisions:records.length,commands,correctnessPassed:true,controlP95,candidateP95,ratio:candidateP95/controlP95,
    controlMax:Math.max(...records.map(r=>r.controlMs)),candidateMax:Math.max(...records.map(r=>r.candidateMs)),records,slow},null,2))
},3_600_000)

it.skipIf(process.env.BF_FINAL_MATCHES!=='1')('runs the locked payoff shard only after the engineering gate passes',()=>{
  const p=assertAcceptanceFrozen(),gate=JSON.parse(readFileSync(`${ACCEPTANCE_DIR}/engineering-gate.json`,'utf8'))
  expect(gate.pass).toBe(true);expect(gate.fingerprint).toBe(p.fingerprint)
  const panel=process.env.BF_FINAL_PANEL as PanelId,offset=Number(process.env.BF_FINAL_OFFSET??0),count=Number(process.env.BF_FINAL_COUNT??16)
  const group=p.matches.find((g:any)=>g.panel===panel)
  if(!group||!Number.isInteger(offset)||!Number.isInteger(count)||offset<0||count<1||offset+count>64)throw new Error('Invalid locked shard')
  const dir=`${ACCEPTANCE_DIR}/${panel}-${offset}`;if(existsSync(dir))throw new Error('Fresh locked shard required')
  mkdirSync(dir,{recursive:true});const rows:PanelPair[]=[],start=Date.now()
  writeFileSync(`${dir}/metadata.json`,JSON.stringify({panel,offset,count,seeds:group.seeds.slice(offset,offset+count),fingerprint:p.fingerprint}))
  for(const seed of group.seeds.slice(offset,offset+count)){
    const batch=([0,1,2,3] as const).map(seat=>panelPair(panel,seed,seat,4,true,candidatePolicy,controlPolicy,false))
    rows.push(...batch);writeFileSync(`${dir}/seed-${seed}.json`,JSON.stringify(batch))
    writeFileSync(`${dir}/progress.json`,JSON.stringify({completed:rows.length/4,count,seconds:(Date.now()-start)/1000}))
  }
  assertAcceptanceFrozen();writeFileSync(`${dir}/done.json`,JSON.stringify({fingerprint:p.fingerprint,rows,seconds:(Date.now()-start)/1000},null,2))
},14_400_000)
