import {expect,it,vi} from 'vitest'
import {createBloodFlowDecisions,bloodFlowDecisionPrompt} from './bloodFlowRuntime'
import {buildBloodFlowDecisionInput} from './bloodFlowDecisionInput'
import {BLOOD_FLOW_LLM_AI} from '../variants/lotus/bloodFlow/config'
import type {BloodFlowSeatView} from '../variants/lotus/bloodFlow/seatView'
import early from './fixtures/bloodFlow-2c926534/round-2-window-63-2.json'
import late5 from './fixtures/bloodFlow-2c926534/round-4-window-316-1.json'
import late4 from './fixtures/bloodFlow-2c926534/round-4-window-321-1.json'
const view=(v:unknown)=>structuredClone(v) as BloodFlowSeatView
it('executes the verified wide-wait reform instead of requesting a model that chooses immediate chicken win',async()=>{
  const v=view(early),request=vi.fn(async()=>({choice:'A0',message:'先胡了'})),source=vi.fn()
  const service=createBloodFlowDecisions({aiConfig:BLOOD_FLOW_LLM_AI,now:()=>0,waits:async()=>[],request,
    provider:()=>({id:'test',name:'test',baseUrl:'https://example.invalid',apiKey:'test-only',model:'mock',providerType:'custom',style:'稳健',timeoutMs:40000}),
    analysis:{source,candidates:vi.fn(),promptTemplate:vi.fn(),attemptStarted:vi.fn(()=>'attempt'),attemptFinished:vi.fn()} as any})
  const action=await service.decide(v,()=>true)
  expect(action?.kind).toBe('discard')
  if(action?.kind==='discard')expect(v.players[v.seat].hand[action.index]).toBe('m1')
  expect(request).not.toHaveBeenCalled()
  expect(source).toHaveBeenCalledWith(expect.objectContaining({source:'local-strategy',reason:'verified-any-wait-reform'}))
})
it.each([late5,late4])('does not let a five-point floor veto the last normal draw opportunity at $window.id',raw=>{
  const v=view(raw),built=buildBloodFlowDecisionInput(v,'late',{},BLOOD_FLOW_LLM_AI)
  expect(built.candidates.find(c=>c.id===built.request.engineSuggestion)?.action.kind).toBe('win')
  const win=built.candidates.find(c=>c.action.kind==='win')!
  expect(win.features.ev?.win?.declinedReason).toBeUndefined()
})

import sameWide from './fixtures/bloodFlow-2c926534/round-1-window-73-1.json'
import {bloodFlowWinSafeguard} from './bloodFlowWinSafeguards'
import {isLastOpportunityRon,remainingNormalDraws} from '../variants/lotus/bloodFlow/winOpportunity'
it('does not force reform when the current locked hand is already any-wait',()=>{
  expect(bloodFlowWinSafeguard(view(sameWide),BLOOD_FLOW_LLM_AI)).toBeNull()
})
it('does not force reform with only one normal future draw or a large immediate win',()=>{
  const one=view(early);one.wallCount=4
  expect(bloodFlowWinSafeguard(one,BLOOD_FLOW_LLM_AI)).toBeNull()
  const rich=view(early);rich.ownScore={...rich.ownScore!,paymentPerPayer:1280}
  expect(bloodFlowWinSafeguard(rich,BLOOD_FLOW_LLM_AI)).toBeNull()
})
it('does not force a dangerous orphan discard into a publicly locked thirteen-orphans hand',()=>{
  const v=view(early)
  v.public={...v.public,seats:v.public.seats.map((s,i)=>i===0?{...s,locked:true,winCount:1}:s) as any}
  v.public={...v.public,batches:[{source:{id:'risk',kind:'draw',seat:0,tile:'east'},winners:[{winner:0,ordinal:1,score:{...v.ownScore!,items:[{id:'thirteenOrphans',label:'十三幺',weight:32}],patternMultiplier:32,finalMultiplier:64,paymentPerPayer:640}}]}] as any}
  expect(bloodFlowWinSafeguard(v,BLOOD_FLOW_LLM_AI)).toBeNull()
})
it('retains the ordinary floor with two or more normal draw opportunities',()=>{
  const v=view(late5);v.wallCount=12
  expect(remainingNormalDraws(v,2)).toBe(2)
  expect(isLastOpportunityRon(v,BLOOD_FLOW_LLM_AI)).toBe(false)
  const b=buildBloodFlowDecisionInput(v,'earlier',{},BLOOD_FLOW_LLM_AI)
  expect(b.candidates.find(c=>c.action.kind==='win')?.features.ev?.win?.floor).toBe(10)
})
it('never bypasses meld priority, rob-kong comparison or already-locked handling',()=>{
  const claim=view(late5);claim.ownActions=[...claim.ownActions,{kind:'peng'}]
  expect(isLastOpportunityRon(claim,BLOOD_FLOW_LLM_AI)).toBe(false)
  expect(bloodFlowWinSafeguard(claim,BLOOD_FLOW_LLM_AI)).toBeNull()
  const rob=view(late5);rob.window={...rob.window!,source:{...rob.window!.source,kind:'added-kong'}};rob.ownScore={...rob.ownScore!,source:'robbed-kong'}
  expect(isLastOpportunityRon(rob,BLOOD_FLOW_LLM_AI)).toBe(false)
  const locked=view(early);locked.public={...locked.public,seats:locked.public.seats.map((s,i)=>i===locked.seat?{...s,locked:true}:s) as any}
  expect(bloodFlowWinSafeguard(locked,BLOOD_FLOW_LLM_AI)).toBeNull()
})
it('records a late ron as local strategy without asking a model to pass again',async()=>{
  const v=view(late4),request=vi.fn(),source=vi.fn()
  const service=createBloodFlowDecisions({aiConfig:BLOOD_FLOW_LLM_AI,request,
    analysis:{source,candidates:vi.fn()} as any})
  expect(await service.decide(v,()=>true)).toEqual({kind:'win'})
  expect(request).not.toHaveBeenCalled()
  expect(source).toHaveBeenCalledWith(expect.objectContaining({source:'local-strategy',reason:'last-ron-opportunity'}))
  expect(await service.decide(v,()=>false)).toBeNull()
  const payload=bloodFlowDecisionPrompt(v,[],'late',undefined,{},'稳健',BLOOD_FLOW_LLM_AI)
  expect(payload.variables.candidates.find(c=>c.label.startsWith('胡牌'))?.features.ev?.win?.floorWaived).toBe(true)
  expect(payload.messages.user).toContain('正常轮转至多一次')
})
it('supports explicitly frozen historical configurations',()=>{
  const old={...BLOOD_FLOW_LLM_AI,winOpportunityGuards:false}
  expect(bloodFlowWinSafeguard(view(early),old)).toBeNull()
  const b=buildBloodFlowDecisionInput(view(late4),'old',{},old)
  expect(b.candidates.find(c=>c.id===b.request.engineSuggestion)?.action.kind).toBe('pass')
})
