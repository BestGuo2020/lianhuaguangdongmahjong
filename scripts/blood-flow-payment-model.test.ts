import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {fitRidge,predictRidge} from './blood-flow-payment-ridge'
import {candidatePublicFeatures} from './blood-flow-payment-public-features'
import type {BloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
it('matches a solvable ridge problem and preserves antisymmetry for paired differences',()=>{
  const model=fitRidge([[-1],[1]],[-2,2],true)
  expect(predictRidge(model,[1])).toBeCloseTo(1)
  expect(predictRidge(model,[-1])).toBeCloseTo(-1)
  expect(predictRidge(model,[0])).toBe(0)
})
it('fits a constant intercept without fabricating variation and clips negative payments',()=>{
  const model=fitRidge([[3],[3]],[10,10],false)
  expect(predictRidge(model,[3])).toBeCloseTo(10)
  expect(predictRidge({...model,intercept:-1},[3])).toBe(0)
})
it('uses only decision-time legal information and reproduces frozen candidate gross values',()=>{
  const record=JSON.parse(readFileSync('docs/blood-flow/records/conditional-ron-loss-2026-09-20.json','utf8')).first
  const view=record.view as BloodFlowSeatView,copy=structuredClone(view)
  const original=candidatePublicFeatures(view,record.old.index)
  expect(original.grossH8).toBeCloseTo(record.newEv.reformCandidates.find((r:any)=>r.index===record.old.index).ev,8)
  copy.roundId='unrelated-source';copy.window!.id='unrelated-window'
  // Even a spectator payload must not make another concealed hand a predictor.
  copy.players[1].hand=['m1','m1','white']
  expect(candidatePublicFeatures(copy,record.old.index)).toEqual(original)
  copy.wallCount=8
  expect(candidatePublicFeatures(copy,record.old.index).tailPaired.every(v=>v===0)).toBe(true)
})
