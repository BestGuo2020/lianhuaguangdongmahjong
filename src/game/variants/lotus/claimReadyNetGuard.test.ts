import { expect, it } from 'vitest'
import { decideClaim, type LotusClaimView } from './lotusAi'
import { waitingTiles } from './lotusRules'
import { BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI } from './bloodFlow/config'

function view(): LotusClaimView {
  return { hand:['p4','p5','p6','p6','s1','s3','s8','s8','south','west','west','green','white'],
    melds:[],exposedMelds:0,jokers:['p4','p5'],tile:'p6',from:2,canPeng:true,canGang:false,chiOptions:[],wallCount:35,
    claimMeldProjection:true,patternBonus:()=>0 }
}

it('can decline an expensive ready promotion that hard readiness would take', () => {
  const input={...view(),safetyExposure:()=>10_000}
  expect(waitingTiles(input.hand,0,input.jokers)).toEqual([])
  expect(decideClaim({...input,claimReadyNetGuard:false}).kind).toBe('peng')
  expect(decideClaim({...input,claimReadyNetGuard:true})).toEqual({kind:'pass'})
})

it('still claims a ready promotion with a positive net gain', () => {
  const input={...view(),patternBonus:(hand:string[])=>hand.length<13?10_000:0}
  expect(decideClaim({...input,claimReadyNetGuard:true}).kind).toBe('peng')
})

it('preserves default/rollback and kong handling without mutating inputs', () => {
  const input=view(),before=structuredClone({hand:input.hand,melds:input.melds})
  expect(decideClaim(input)).toEqual(decideClaim({...input,claimReadyNetGuard:false}))
  expect(decideClaim({...input,canGang:true,claimReadyNetGuard:true})).toEqual({kind:'gang'})
  expect({hand:input.hand,melds:input.melds}).toEqual(before)
  expect(BLOOD_FLOW_LLM_AI.claimReadyNetGuard).toBe(false)
  expect(BLOOD_FLOW_AI.claimReadyNetGuard).toBe(import.meta.env.VITE_BLOOD_FLOW_CLAIM_READY_NET_GUARD!=='off')
})
