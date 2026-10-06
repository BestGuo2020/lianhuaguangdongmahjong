import {afterEach,expect,it,vi} from 'vitest'
import {bloodFlowDecisionPrompt,createBloodFlowDecisions,loadBloodFlowWaits} from './bloodFlowRuntime'
import {bloodFlowClaimWaitComparison,bloodFlowReadiness,bloodFlowStandingHand} from './bloodFlowWaitComparison'
import {evaluateWaits} from '../variants/lotus/patterns/evaluate'
import {BLOOD_FLOW_LLM_AI} from '../variants/lotus/bloodFlow/config'
import type {BloodFlowSeatView} from '../variants/lotus/bloodFlow/seatView'
import raw from './fixtures/bloodFlow-48bd88a9/round-3-window-68-3.json'

const view=()=>structuredClone(raw) as unknown as BloodFlowSeatView
const evaluator=vi.hoisted(()=>({waits:vi.fn(),cancel:vi.fn()}))
vi.mock('../variants/lotus/patterns/evaluatorService',()=>({createEvaluatorService:()=>evaluator}))
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks()})
it('shows the existing any-wait and the 34-to-3 loss when GLM can chi but cannot win',()=>{
 const v=view(),before=structuredClone(v)
 const p=bloodFlowDecisionPrompt(v,[],'regression','话痨',{},'话痨',BLOOD_FLOW_LLM_AI)
 const data=JSON.parse(p.messages.user)
 expect(data.readyState).toMatchObject({ready:true,anyWait:true,selfDrawOnly:true,selfDrawWaitCount:34,discardWaitCount:0})
 expect(data.defense).toMatchObject({ownShanten:0,ownCanTenpai:true,ownAlreadyAnyWait:true})
 const pass=data.candidates.find((c:any)=>c.label==='过'),chi=data.candidates.find((c:any)=>c.label==='吃四筒五筒六筒')
 expect(pass.features.ready).toBe(true)
 expect(pass.features.waitComparison).toMatchObject({before:{anyWait:true,selfDrawWaitCount:34},after:{anyWait:true,selfDrawWaitCount:34},requiresDiscard:false,breaksAnyWait:false})
 expect(chi.features.waitComparison).toMatchObject({before:{anyWait:true,selfDrawWaitCount:34},after:{anyWait:false,selfDrawWaitCount:3,discardWaitCount:1},requiresDiscard:true,breaksAnyWait:true})
 expect(chi.features.risks.join('')).toContain('精吊')
 expect(p.request.engineSuggestion).toBe('A1')
 expect(p.candidates.map(c=>c.action)).toEqual(v.ownActions)
 expect(v).toEqual(before)
 expect(data.publicPlayers.every((p:any)=>!('hand' in p))).toBe(true)
})

it('loads scored waits despite no win on the incoming tile and carries them into the actual request',async()=>{
 vi.stubGlobal('Worker',class {})
 evaluator.waits.mockImplementation(async input=>evaluateWaits(input))
 const v=view(),payloads:any[]=[]
 const service=createBloodFlowDecisions({provider:()=>({id:'test',name:'test',baseUrl:'https://model.example.test/v1',apiKey:'unit-test-only',providerType:'custom',model:'fixture-model',style:'稳健',timeoutMs:40_000}),
   request:async o=>{const p=JSON.parse(o.messages.user);payloads.push(p);return {choice:p.engineSuggestion,message:''}},
   now:()=>0,aiConfig:BLOOD_FLOW_LLM_AI})
 expect(await service.decide(v,()=>true)).toEqual({kind:'pass'})
 expect(evaluator.waits).toHaveBeenCalledWith({concealed:v.players[3].hand,melds:v.players[3].melds,jokers:v.jokers})
 expect(evaluator.cancel).toHaveBeenCalledTimes(1)
 expect(payloads[0].waits).toHaveLength(34)
 expect(payloads[0].waits.every((w:any)=>w.selfDrawPerPayer>0&&w.discardPerPayer===null)).toBe(true)
 expect(payloads[0].readyState.anyWait).toBe(true)
 expect(JSON.stringify(payloads[0])).not.toContain('unit-test-only')
})

it('uses the pre-draw hand for self-draw, but never removes a tile after chi/peng',async()=>{
 const v=view(),p=v.players[3]
 p.hand.push('m1');p.drawnTileIndex=p.hand.length-1;v.window!.kind='turn'
 expect(bloodFlowStandingHand(v)).toEqual(raw.players[3].hand)
 expect(bloodFlowReadiness(v).summary?.anyWait).toBe(true)
 p.drawnTileIndex=-1
 expect(bloodFlowStandingHand(v)).toBeNull()
 expect(bloodFlowReadiness(v).summary).toBeNull()
 vi.stubGlobal('Worker',class {})
 await expect(loadBloodFlowWaits(v,new AbortController().signal)).resolves.toEqual([])
 expect(evaluator.waits).not.toHaveBeenCalled()
})

it('does not call the evaluator for cancelled requests or incomplete hands',async()=>{
 vi.stubGlobal('Worker',class {})
 const abort=new AbortController();abort.abort()
 await expect(loadBloodFlowWaits(view(),abort.signal)).resolves.toEqual([])
 const v=view();v.players[3].hand=['p4','p5']
 expect(bloodFlowReadiness(v).summary).toBeNull()
 await expect(loadBloodFlowWaits(v,new AbortController().signal)).resolves.toEqual([])
 expect(evaluator.waits).not.toHaveBeenCalled()
})

it('distinguishes creating any-wait from preserving an existing one',()=>{
 const v=view();v.players[3].hand=['p4','p5','s3','s4','s8','red','red'];v.window!.source.tile='red'
 const before=bloodFlowReadiness(v).summary
 expect(before?.anyWait).toBe(false)
 expect(bloodFlowClaimWaitComparison(v,{kind:'peng'},before)).toMatchObject({createsAnyWait:true,preservesAnyWait:false,breaksAnyWait:false,after:{anyWait:true}})
})

it('shows that peng can preserve any-wait and does not mark every meld as destructive',()=>{
 const v=view();v.players[3].hand=['p4','p5','s3','s4','s5','red','red'];v.window!.source.tile='red'
 const before=bloodFlowReadiness(v).summary
 expect(before?.anyWait).toBe(true)
 const compared=bloodFlowClaimWaitComparison(v,{kind:'peng'},before)
 expect(compared).toMatchObject({requiresDiscard:true,preservesAnyWait:true,breaksAnyWait:false,after:{anyWait:true,selfDrawWaitCount:34,discardWaitCount:0}})
})
