import {expect,it} from 'vitest'
import {bloodFlowImpactProfile,bloodFlowTitleMotion} from './bloodFlowPresentation'
import type {BloodFlowCue} from '../game/variants/lotus/bloodFlow/presentation'
it('distinguishes physical effect tiers and keeps shared time marks readable',()=>{
  const ordinary=bloodFlowImpactProfile('jade',0),top=bloodFlowImpactProfile('jade',3)
  expect(ordinary.beamHeight).toBe(0);expect(top.beamHeight).toBeGreaterThan(ordinary.beamHeight)
  expect(top.particleCount).toBeGreaterThan(ordinary.particleCount)
  expect(bloodFlowImpactProfile('happyMahjong',3).shape).not.toBe(bloodFlowImpactProfile('jade',3).shape)
  expect(bloodFlowImpactProfile('llm',3).font).not.toBe(bloodFlowImpactProfile('rosewood',3).font)
  const cue={startedAt:100,tier:3,compact:false,duration:1600,phaseMarks:{focus:0,impact:180,readable:350,score:650,exit:1360}} as BloodFlowCue
  expect(bloodFlowTitleMotion(cue,280,'jade').scale).toBeGreaterThan(1.4)
  expect(bloodFlowTitleMotion(cue,450,'jade').scale).toBe(1)
  expect(bloodFlowTitleMotion(cue,1700,'jade').opacity).toBe(0)
  expect(bloodFlowImpactProfile('llmAnime',3,false,true)).toMatchObject({particleCount:0,beamHeight:0,cameraStrength:0,dimming:0})
})
