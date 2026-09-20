import {expect,it} from 'vitest'
import type {TileType} from '../../../core/contracts/types'
import {conditionalCategoryProbabilities,forecastConditionalIncome,type ConditionalRonModel} from './conditionalRon'
import {forecastCalibratedIncome} from './incomeForecast'
const uniform={ 'wildcard-face':1,honor:1,terminal:1,middle:1 }
it('renormalizes against available categories and backs sparse cells off to their parent',()=>{
  const model:ConditionalRonModel={version:1,weights:{false:{...uniform,'wildcard-face':0.1,terminal:2}}}
  const prior={ 'wildcard-face':0,honor:.2,terminal:.3,middle:.5 }
  const p=conditionalCategoryProbabilities(prior,false,'high-over-160',model)
  expect(p['wildcard-face']).toBe(0)
  expect(p.terminal).toBeCloseTo(.6/1.3)
  expect(Object.values(p).reduce((a,b)=>a+b,0)).toBeCloseTo(1)
})
it('reduces to frozen source-v2 when category propensities are neutral at every seat offset',()=>{
  const hand='east east south p3 p4 p5 p6 p6 p7 p9 white white white'.split(' ') as TileType[]
  const jokers:TileType[]=['east','south'],calibration={drawScale:.998,discardScale:.899,selfYield:.848,ronYield:.988}
  const model:ConditionalRonModel={version:1,weights:{global:uniform}}
  for(const wall of [0,1,3,4,13,40])for(const offset of [1,2,3,4])for(const horizon of [0,1,8]){
    expect(forecastConditionalIncome(hand,[],jokers,hand,wall,horizon,offset,calibration,2,[true,false,false,true],model))
      .toBeCloseTo(forecastCalibratedIncome(hand,[],jokers,hand,wall,horizon,offset,calibration),8)
  }
})
