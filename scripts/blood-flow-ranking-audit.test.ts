import {it,expect} from 'vitest'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {PANEL_CURRENT_CONFIG} from './blood-flow-opponent-panel'
import {decideBloodFlowActionEv,bloodFlowSafetyExposure} from '../src/game/variants/lotus/bloodFlow/ai'
import {rankingDecision} from './blood-flow-ranking-policy'
import type {BloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'))
const base={...PANEL_CURRENT_CONFIG,chainForecast:'source-v2' as const,reformGainRatio:1.2,
  opportunityCalibration:read('docs/blood-flow/records/opportunity-calibration-2026-09-20.json').calibration}
const original=read('docs/blood-flow/records/conditional-ron-loss-2026-09-20.json').first.view as BloodFlowSeatView
it('breaks exact EV ties by index independently of legal-action enumeration',()=>{
  const reversed={...structuredClone(original),ownActions:[...original.ownActions].reverse()}
  expect(decideBloodFlowActionEv(reversed,base)).toEqual(decideBloodFlowActionEv(original,base))
})
it.skipIf(process.env.BF_RANK_AUDIT!=='1')('audits parameter sensitivity on the selected old loss, without treating it as new evidence',()=>{
  const model=read('docs/blood-flow/records/conditional-ron-model-2026-09-20.json').model
  const ensemble=read('work/blood-flow-ranking/bootstrap.json').models
  const before=JSON.stringify(original),result=rankingDecision(original,base,model,ensemble)
  expect(JSON.stringify(original)).toBe(before)
  expect(original.ownActions).toContainEqual(result.robust)
  mkdirSync('work/blood-flow-ranking',{recursive:true})
  const exposure=bloodFlowSafetyExposure(original,base)
  writeFileSync('work/blood-flow-ranking/known-case.json',JSON.stringify({scope:'Previously selected diagnostic; excluded from new validation.',result,
    existingSafetyHeuristic:{m3:exposure('m3'),s5:exposure('s5')}},null,2))
},120_000)
