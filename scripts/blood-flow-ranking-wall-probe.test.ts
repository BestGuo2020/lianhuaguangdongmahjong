import {it,expect} from 'vitest'
import {readFileSync,writeFileSync} from 'node:fs'
import {BloodFlowEngine} from '../src/game/variants/lotus/bloodFlow/engine'
import {bloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
import {seededRandom} from '../src/game/variants/lotus/bloodFlow/simulation'
import {BLOOD_FLOW_CONFIG} from '../src/game/variants/lotus/bloodFlow/config'
import {vector} from '../src/game/variants/lotus/bloodFlow/state'
import type {Seat} from '../src/game/variants/lotus/bloodFlow/types'
import {decideBloodFlowActionEv} from '../src/game/variants/lotus/bloodFlow/ai'
import {PANEL_CURRENT_CONFIG,opponentFor} from './blood-flow-opponent-panel'
import {nextSeatToAct,submit,snapshotEngine,restoreEngine,permuteWall,finish} from './blood-flow-counterfactual'
it.skipIf(process.env.BF_RANK_WALL!=='1')('probes paired remaining-wall sensitivity without exposing hidden state to policies',()=>{
  const base={...PANEL_CURRENT_CONFIG,chainForecast:'source-v2' as const,reformGainRatio:1.2,
    opportunityCalibration:JSON.parse(readFileSync('docs/blood-flow/records/opportunity-calibration-2026-09-20.json','utf8')).calibration}
  const policy=(v:Parameters<typeof decideBloodFlowActionEv>[0])=>decideBloodFlowActionEv(v,base)
  const policies=([0,1,2,3] as const).map(seat=>seat===0?policy:opponentFor('mixed',292006,0,seat))
  let scores=vector(()=>BLOOD_FLOW_CONFIG.initialScore),checkpoint:ReturnType<typeof snapshotEngine>|null=null
  for(let round=0;round<2;round++){
    const e=new BloodFlowEngine({authorityEpoch:'ranking-probe',roundId:`292006/${round}`,dealer:round as Seat,scores,
      random:seededRandom((Math.imul(292006,4)+round)>>>0),now:()=>0,winBeatMs:0,paced:false})
    while(!e.result){
      const seat=nextSeatToAct(e),view=bloodFlowSeatView(e,seat)
      if(round===1&&seat===0&&view.wallCount===44&&view.ownActions.some(a=>a.kind==='win')){
        expect(view.players[0].hand[2]).toBe('m3');expect(view.players[0].hand[9]).toBe('s5')
        expect(policy(view)).toEqual({kind:'discard',index:2});checkpoint=snapshotEngine(e);break
      }
      const action=policies[seat](view);if(!action)throw new Error('Missing action');submit(e,seat,action)
    }
    if(checkpoint)break
    scores=vector(s=>e.players[s].score)
  }
  expect(checkpoint).not.toBeNull()
  const rows=[]
  for(let sample=-1;sample<32;sample++){
    const outcomes=[2,9].map(index=>{
      const e=restoreEngine(checkpoint!),start=e.players[0].score,ledger=e.ledger.length
      if(sample>=0)permuteWall(e,(Math.imul(sample+1,300031))>>>0)
      submit(e,0,{kind:'discard',index});finish(e,policies)
      let paid=0
      for(const entry of e.ledger.slice(ledger))if(entry.kind==='win'&&entry.batch.source.kind==='discard'&&entry.batch.source.seat===0)paid-=entry.batch.deltas[0]
      return {index,net:e.players[0].score-start,discardPayments:paid}
    })
    rows.push({sample,outcomes,delta:outcomes[1].net-outcomes[0].net})
  }
  writeFileSync('work/blood-flow-ranking/wall-probe.json',JSON.stringify({scope:'Selected historical position, fixed opponent hidden hands, paired uniform remaining-wall permutations, rest-of-round only, common frozen continuation. Sensitivity probe NOT a posterior over all hidden worlds or independent strength evidence.',rows},null,2))
},600_000)
