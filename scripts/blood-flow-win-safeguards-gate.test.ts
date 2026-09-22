import {it,expect} from 'vitest'
import fs from 'node:fs'
import {performance} from 'node:perf_hooks'
import {BLOOD_FLOW_LLM_AI} from '../src/game/variants/lotus/bloodFlow/config'
import {bloodFlowDecisionPlan} from '../src/game/llm/bloodFlowDecisionInput'
import {bloodFlowWinSafeguard} from '../src/game/llm/bloodFlowWinSafeguards'
import {panelPair,type PanelId,PANEL_CURRENT_CONFIG,ATTACK_CONFIG,DEFENSIVE_CONFIG} from './blood-flow-opponent-panel'
import type {BloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
import type {Seat} from '../src/game/variants/lotus/bloodFlow/types'
import {seededRandom} from '../src/game/variants/lotus/bloodFlow/simulation'
const dir='work/analysis-2c926534',mean=(v:number[])=>v.reduce((s,n)=>s+n,0)/v.length
const q=(v:number[],p:number)=>[...v].sort((a,b)=>a-b)[Math.max(0,Math.ceil(v.length*p)-1)]!
it('runs fixed new-seed safeguards holdout without model calls',()=>{
  const control={...BLOOD_FLOW_LLM_AI,winOpportunityGuards:false},candidate={...control,winOpportunityGuards:true}
  const panels:PanelId[]=['legacy','attack','defensive','mixed'],samples:BloodFlowSeatView[]=[],seen=new Set<string>(),hits:Record<string,number>={}
  const start=performance.now(),rows:any[]=[]
  const action=(v:BloodFlowSeatView,on:boolean)=>{
    if(performance.now()-start>900000)throw Error('fixed-budget-exhausted')
    if(v.players.some(p=>p.seat!==v.seat&&p.hand.length))throw Error('private-hand-leak')
    const key=v.roundId+'/'+v.window?.id+'/'+v.seat
    if(samples.length<128&&!seen.has(key)&&!v.public.seats[v.seat].locked){seen.add(key);samples.push(structuredClone(v))}
    const guard=on?bloodFlowWinSafeguard(v,candidate):null
    if(guard)hits[guard.reason]=(hits[guard.reason]??0)+1
    return guard?.action??bloodFlowDecisionPlan(v,on?candidate:control).recommended??null
  }
  fs.writeFileSync(dir+'/safeguard-gate-config.json',JSON.stringify({control,candidate,opponents:{PANEL_CURRENT_CONFIG,ATTACK_CONFIG,DEFENSIVE_CONFIG}},null,2))
  let error:string|null=null
  try{for(let i=0;i<8;i++)for(let seat=0;seat<4;seat++){
    rows.push(panelPair(panels[Math.floor(i/2)]!,6300001+i,seat as Seat,4,true,v=>action(v,true),v=>action(v,false),false))
    fs.writeFileSync(dir+'/safeguard-gate-rows.json',JSON.stringify(rows))
  }}catch(e){error=String(e)}
  const times=[[] as number[],[] as number[]]
  const measured=(v:BloodFlowSeatView,on:boolean)=>on?(bloodFlowWinSafeguard(v,candidate)?.action??bloodFlowDecisionPlan(v,candidate).recommended):bloodFlowDecisionPlan(v,control).recommended
  for(const v of samples){measured(v,false);measured(v,true)}
  samples.forEach((v,i)=>{for(const arm of i%2?[1,0]:[0,1]){const t=performance.now();measured(v,!!arm);times[arm]!.push(performance.now()-t)}})
  const groups=Array.from({length:8},(_,i)=>rows.filter(r=>r.seed===6300001+i)).filter(g=>g.length===4)
  const ds=groups.map(g=>mean(g.map(r=>r.delta))),net=mean(ds)
  const rankDelta=mean(rows.map(r=>Number(r.currentRank===1)-Number(r.controlRank===1)))
  const tailDelta=mean(rows.map(r=>Number(r.currentNet<=-1000)-Number(r.controlNet<=-1000)))
  const rng=seededRandom(6309001),boot:number[]=[]
  if(groups.length===8)for(let n=0;n<5000;n++){const pick:number[]=[];for(let p=0;p<4;p++)for(let k=0;k<2;k++)pick.push(ds[p*2+Math.floor(rng()*2)]!);boot.push(mean(pick))}
  const p95=times.map(t=>q(t,.95)),ratio=p95[1]!/p95[0]!
  const out={complete:rows.length===32,error,pairs:rows.length,net,ci:boot.length?[q(boot,.025),q(boot,.975)]:null,rankDelta,tailDelta,p95,ratio,hits,changedPairs:rows.filter(r=>r.changed).length,elapsedMs:performance.now()-start,
    adopt:rows.length===32&&!error&&net>=0&&rankDelta>=0&&tailDelta<=0&&ratio<=2}
  fs.writeFileSync(dir+'/safeguard-gate.json',JSON.stringify(out,null,2))
  expect(error).toBeNull()
},930000)
