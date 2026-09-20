import {it,expect} from 'vitest'
import {readFileSync,writeFileSync} from 'node:fs'
import {panelPair,PANEL_CURRENT_CONFIG} from './blood-flow-opponent-panel'
import {decideBloodFlowActionEv} from '../src/game/variants/lotus/bloodFlow/ai'
import {bloodFlowEvContext} from '../src/game/variants/lotus/bloodFlow/evContext'
import type {BloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
it.skipIf(process.env.BF_CONDITIONAL_LOSS!=='1')('reproduces the largest held-out decision loss without refitting',()=>{
  const opportunityCalibration=JSON.parse(readFileSync('docs/blood-flow/records/opportunity-calibration-2026-09-20.json','utf8')).calibration
  const conditionalRon=JSON.parse(readFileSync('work/blood-flow-conditional/model.json','utf8')).model
  const base={...PANEL_CURRENT_CONFIG,chainForecast:'source-v2' as const,opportunityCalibration,reformGainRatio:1.2}
  const config={...base,conditionalRon}
  const control=(view:BloodFlowSeatView)=>decideBloodFlowActionEv(view,base)
  let first:unknown=null
  const candidate=(view:BloodFlowSeatView)=>{
    const chosen=decideBloodFlowActionEv(view,config),old=control(view)
    if(!first&&JSON.stringify(chosen)!==JSON.stringify(old)){
      expect(view.players.every((p,i)=>i===view.seat||!p.hand.length)).toBe(true)
      first={view:structuredClone(view),chosen,old,oldEv:bloodFlowEvContext(view,base),newEv:bloodFlowEvContext(view,config)}
    }
    return chosen
  }
  const result=panelPair('mixed',292006,0,4,true,candidate,control,false)
  expect(result.delta).toBe(-6755);expect(first).not.toBeNull()
  writeFileSync('work/blood-flow-conditional/loss.json',JSON.stringify({scope:'Selected post-holdout diagnostic, not independent confirmation or fitting input.',result,first},null,2))
},300_000)
