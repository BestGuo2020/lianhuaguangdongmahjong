import {readFileSync} from 'node:fs'
import type {BloodFlowEngine} from '../src/game/variants/lotus/bloodFlow/engine'
import {bloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
import type {BloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
import {decideBloodFlowActionEv} from '../src/game/variants/lotus/bloodFlow/ai'
import type {Seat} from '../src/game/variants/lotus/bloodFlow/types'
import {PANEL_CURRENT_CONFIG} from './blood-flow-opponent-panel'
import {restoreEngine,permuteWall,nextSeatToAct,submit} from './blood-flow-counterfactual'
export const WINDOW_BASE={...PANEL_CURRENT_CONFIG,chainForecast:'source-v2' as const,reformGainRatio:1.2,
  opportunityCalibration:JSON.parse(readFileSync('docs/blood-flow/records/opportunity-calibration-2026-09-20.json','utf8')).calibration}
export const WINDOW_MODEL=JSON.parse(readFileSync('docs/blood-flow/records/conditional-ron-model-2026-09-20.json','utf8')).model
export const windowPolicy=(view:Parameters<typeof decideBloodFlowActionEv>[0])=>decideBloodFlowActionEv(view,WINDOW_BASE)
export function actualOwnDraw(view:BloodFlowSeatView,seat:Seat){
  return view.seat===seat&&view.window?.kind==='turn'&&view.window.source.kind==='draw'
    &&view.players[seat].drawnTileIndex>=0
}

export function pointLedger(e:BloodFlowEngine,seat:Seat,start:number,forcedSource:string){
  let gross=0,discardPaid=0,otherWinPaid=0,kongNet=0,immediateDiscardPaid=0
  for(const entry of e.ledger.slice(start)){
    if(entry.kind==='kong'){kongNet+=entry.deltas[seat];continue}
    for(const w of entry.batch.winners){
      const delta=w.deltas[seat]
      if(delta>0)gross+=delta
      else if(delta<0){
        if(entry.batch.source.kind==='discard'&&entry.batch.source.seat===seat){
          discardPaid-=delta
          if(entry.batch.source.id===forcedSource)immediateDiscardPaid-=delta
        }else otherWinPaid-=delta
      }
    }
  }
  return {gross,discardPaid,otherWinPaid,kongNet,immediateDiscardPaid,net:gross-discardPaid-otherWinPaid+kongNet}
}
export function windowOutcome(checkpoint:Record<string,unknown>,seat:Seat,index:number,sample:number,wallSeed:number){
  const e=restoreEngine(checkpoint),before=e.players[seat].score,start=e.ledger.length
  if(sample>=0)permuteWall(e,wallSeed)
  submit(e,seat,{kind:'discard',index})
  const source=e.discardActions.at(-1)!.id
  const draws=new Set<string>();let horizon:ReturnType<typeof pointLedger>|null=null,commands=0
  while(!e.result){
    if(++commands>2000)throw new Error('Continuation stalled')
    const actor=nextSeatToAct(e),view=bloodFlowSeatView(e,actor)
    if(view.players.some((p,i)=>i!==actor&&p.hand.length))throw new Error('Hidden hand leak')
    if(!horizon&&actor===seat&&actualOwnDraw(view,seat)){
      draws.add(view.window!.source.id)
      if(draws.size===9){
        horizon=pointLedger(e,seat,start,source)
        if(horizon.net!==e.players[seat].score-before)throw new Error('Horizon ledger mismatch')
      }
    }
    const action=windowPolicy(view);if(!action)throw new Error('No continuation action');submit(e,actor,action)
  }
  const full=pointLedger(e,seat,start,source)
  if(full.net!==e.players[seat].score-before)throw new Error('Ledger mismatch')
  return {horizon:horizon??full,full,ownDraws:Math.min(draws.size,8),commands}
}
