import {expect,it} from 'vitest'
import {sampleBloodFlowFlight} from './bloodFlowTileFlight'
import type {BloodFlowCue} from '../../../game/variants/lotus/bloodFlow/presentation'
const cue={startedAt:1000,tier:3,phaseMarks:{focus:0,impact:180,readable:350,score:650,exit:1360},duration:1600} as BloodFlowCue
it('flies from the recorded source and lands/bounces exactly at the shared cue marks',()=>{
  const source={x:7,y:.56,z:8,rotation:1,tilt:-Math.PI/2},target={x:3.7,y:1.69,z:2.35,rotation:0}
  expect(sampleBloodFlowFlight(source,target,cue,1000)).toMatchObject({...source,progress:0,landed:false})
  const moving=sampleBloodFlowFlight(source,target,cue,1120)
  expect(moving.x).toBeLessThan(source.x);expect(moving.x).toBeGreaterThan(target.x)
  const impact=sampleBloodFlowFlight(source,target,cue,1180)
  for(const axis of ['x','y','z'] as const)expect(impact[axis]).toBeCloseTo(target[axis])
  expect(impact).toMatchObject({progress:1,landed:false})
  expect(sampleBloodFlowFlight(source,target,cue,1250).y).toBeGreaterThan(target.y)
  const landed=sampleBloodFlowFlight(source,target,cue,1350)
  for(const axis of ['x','y','z'] as const)expect(landed[axis]).toBeCloseTo(target[axis])
  expect(landed).toMatchObject({progress:1,landed:true})
  expect(sampleBloodFlowFlight(source,target,cue,1050,true)).toMatchObject({...target,landed:true})
})
