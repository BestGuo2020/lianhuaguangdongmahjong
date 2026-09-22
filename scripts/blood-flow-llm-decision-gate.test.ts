import {it,expect} from 'vitest'
import fs from 'node:fs'
import {performance} from 'node:perf_hooks'
import {BLOOD_FLOW_AI,BLOOD_FLOW_LLM_AI,type BloodFlowAiConfig} from '../src/game/variants/lotus/bloodFlow/config'
import {bloodFlowDecisionPlan,buildBloodFlowDecisionInput} from '../src/game/llm/bloodFlowDecisionInput'
import {panelPair,type PanelId,PANEL_CURRENT_CONFIG,ATTACK_CONFIG,DEFENSIVE_CONFIG} from './blood-flow-opponent-panel'
import {seededRandom} from '../src/game/variants/lotus/bloodFlow/simulation'
import type {BloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
import type {Seat} from '../src/game/variants/lotus/bloodFlow/types'
const dir='work/analysis-c93b3ed8'
const stage=process.env.BF_LLM_STAGE??'source'
const panels:PanelId[]=['legacy','attack','defensive','mixed']
const mean=(v:number[])=>v.reduce((a,b)=>a+b,0)/v.length
const quantile=(v:number[],q:number)=>[...v].sort((a,b)=>a-b)[Math.max(0,Math.ceil(v.length*q)-1)]!
it('fixed independent LLM recommendation panel '+stage,()=>{
  let control:BloodFlowAiConfig={...BLOOD_FLOW_LLM_AI,winOpportunityGuards:false,chainForecast:'legacy',opportunityCalibration:undefined,firstWinFloorEarly:40,firstWinFloorMid:20,firstWinFloorLate:10}
  if(stage==='floor'){
    const previous=JSON.parse(fs.readFileSync(dir+'/gate-source.json','utf8'))
    if(previous.adopt)control={...control,chainForecast:'source-v2',opportunityCalibration:BLOOD_FLOW_AI.opportunityCalibration}
  }
  const candidate:BloodFlowAiConfig=stage==='source'?{...control,chainForecast:'source-v2',opportunityCalibration:BLOOD_FLOW_AI.opportunityCalibration}
    :{...control,firstWinFloorEarly:0,firstWinFloorMid:0,firstWinFloorLate:0}
  const samples:BloodFlowSeatView[]=[],seen=new Set<string>()
  const policy=(config:BloodFlowAiConfig)=>(view:BloodFlowSeatView)=>{
    if(view.players.some(p=>p.seat!==view.seat&&p.hand.length))throw Error('private hand')
    const key=view.roundId+'/'+view.window?.id+'/'+view.seat
    if(samples.length<192&&!seen.has(key)&&!view.public.seats[view.seat].locked){samples.push(structuredClone(view));seen.add(key)}
    return bloodFlowDecisionPlan(view,config).recommended??null
  }
  const rows:any[]=[],start=performance.now(),offset=stage==='source'?6200001:6200101
  fs.writeFileSync(dir+'/gate-'+stage+'-config.json',JSON.stringify({stage,control,candidate,opponents:{PANEL_CURRENT_CONFIG,ATTACK_CONFIG,DEFENSIVE_CONFIG}},null,2))
  let complete=true
  outer:for(let i=0;i<16;i++)for(let seat=0;seat<4;seat++){
    if(performance.now()-start>600000){complete=false;break outer}
    const result=panelPair(panels[Math.floor(i/4)]!,offset+i,seat as Seat,4,true,policy(candidate),policy(control),false)
    rows.push(result)
    fs.writeFileSync(dir+'/gate-'+stage+'-rows.json',JSON.stringify(rows))
  }
  const timings=[[] as number[],[] as number[]]
  for(const view of samples){bloodFlowDecisionPlan(view,control);bloodFlowDecisionPlan(view,candidate)}
  samples.forEach((view,i)=>{
    for(const arm of i%2?[1,0]:[0,1]){const t=performance.now();bloodFlowDecisionPlan(view,arm?candidate:control);timings[arm]!.push(performance.now()-t)}
  })
  for(const view of samples.slice(0,8))for(const config of [control,candidate]){
    const b=buildBloodFlowDecisionInput(view,'parity',{},config)
    expect(b.candidates.find(c=>c.id===b.request.engineSuggestion)?.action).toEqual(bloodFlowDecisionPlan(view,config).recommended)
  }
  const groups=Array.from({length:16},(_,i)=>rows.filter(r=>r.seed===offset+i))
  const differences=groups.filter(g=>g.length===4).map(g=>mean(g.map(r=>r.delta)))
  const random=seededRandom(stage==='source'?6209001:6209002),boot:number[]=[]
  if(complete)for(let b=0;b<5000;b++){const sample:number[]=[];for(let panel=0;panel<4;panel++)for(let k=0;k<4;k++)sample.push(differences[panel*4+Math.floor(random()*4)]!);boot.push(mean(sample))}
  const rankDelta=mean(rows.map(r=>Number(r.currentRank===1)-Number(r.controlRank===1)))
  const tailDelta=mean(rows.map(r=>Number(r.currentNet<=-1000)-Number(r.controlNet<=-1000)))
  const net=mean(differences),ci=complete?[quantile(boot,.025),quantile(boot,.975)]:null
  const p95=timings.map(t=>quantile(t,.95)),timingRatio=p95[1]!/p95[0]!
  const adopt=complete&&net>0&&ci![0]!>0&&rankDelta>=0&&tailDelta<=1/64&&timingRatio<=1.5
  const out={stage,complete,pairs:rows.length,seeds:differences.length,net,ci,rankDelta,tailDelta,p95,timingRatio,adopt,elapsedMs:performance.now()-start,changedPairs:rows.filter(r=>r.changed).length}
  fs.writeFileSync(dir+'/gate-'+stage+'.json',JSON.stringify(out,null,2))
  console.log(JSON.stringify(out))
},660000)
