import {expect,it,vi} from 'vitest'
import {BloodFlowEngine} from '../variants/lotus/bloodFlow/engine'
import {bloodFlowSeatView} from '../variants/lotus/bloodFlow/seatView'
import {seededRandom} from '../variants/lotus/bloodFlow/simulation'
import {bloodFlowDecisionBudget,bloodFlowDecisionPrompt,createBloodFlowDecisions} from './bloodFlowRuntime'
import {buildBloodFlowDecisionInput} from './bloodFlowDecisionInput'
import {BLOOD_FLOW_MOMENT_LINES,bloodFlowWinMomentLine,bloodFlowWinMomentTier} from './bloodFlowWinLines'
import {scorePatterns} from '../variants/lotus/patterns/score'
import type {LlmProviderPreset} from './config'

const provider:LlmProviderPreset={id:'test',name:'test',baseUrl:'https://api.deepseek.com/v1',apiKey:'unit-test-only',
  providerType:'deepseek',model:'deepseek-v4-flash',style:'话痨',timeoutMs:40_000}
function input(){
  const v=bloodFlowSeatView(new BloodFlowEngine({authorityEpoch:'e',roundId:'r',random:seededRandom(23),now:()=>0}),0)
  v.window!.deadlineAt=Infinity;v.ownScore=null
  v.ownActions=v.players[0].hand.map((_,index)=>({kind:'discard',index}))
  return v
}
it('uses shared persona, public facts, calculated features and a legal default recommendation',()=>{
  const v=input(),before=structuredClone(v)
  const built=bloodFlowDecisionPrompt(v,[],'r','话痨',{roundIndex:2,dealerIndex:3})
  const payload=JSON.parse(built.messages.user)
  expect(built.messages.system).toContain('活泼健谈')
  expect(built.messages.system).toContain('默认参考')
  expect(payload.ruleSummary).toContain('胡后继续')
  expect(payload.ruleSummary).not.toContain('胡后买')
  expect(payload.publicState).toMatchObject({ruleCode:'lotus-blood-flow',seatWind:'南',isDealer:false,roundIndex:2})
  expect(payload.publicPlayers.every((p:any)=>!('hand' in p))).toBe(true)
  expect(payload.candidates.some((c:any)=>c.id===payload.engineSuggestion)).toBe(true)
  expect(payload.candidates.every((c:any)=>typeof c.features.shanten==='number')).toBe(true)
  expect(built.messages.user).not.toContain(provider.apiKey)
  expect(v).toEqual(before)
})
it('overrides only blood-flow kong revenue and keeps unknown features unknown',()=>{
  const v=input();v.ownActions=[{kind:'concealed-kong',tile:v.players[0].hand[0]}]
  expect(buildBloodFlowDecisionInput(v,'kong').candidates[0].features.scoreDelta).toBe(60)
  v.players[0].hand=['m1','p2'];v.ownActions=[{kind:'discard',index:0}]
  expect(buildBloodFlowDecisionInput(v,'partial').candidates[0].features).toMatchObject({shanten:'n/a',ready:'unknown',ukeire:'n/a'})
})
it('preserves configured budgets while intersecting a shorter authoritative window',()=>{
  const v=input()
  expect(bloodFlowDecisionBudget(provider,v,0)).toBe(40_000)
  expect(bloodFlowDecisionBudget({...provider,timeoutMs:1200},v,0)).toBe(1200)
  expect(bloodFlowDecisionBudget({...provider,timeoutEnabled:false},v,0)).toBe(Infinity)
  v.window!.deadlineAt=2000
  expect(bloodFlowDecisionBudget({...provider,timeoutEnabled:false},v,0)).toBe(1750)
})
it('shares conditional thinking, safe progress, seat quotas and short-window suppression',async()=>{
  const calls:any[]=[],status=vi.fn()
  const request=vi.fn(async(options:any)=>{calls.push(options);options.onReasoningProgress?.();return {choice:options.candidateIds[0],message:'慢慢来。'}})
  const service=createBloodFlowDecisions({provider:()=>provider,request,waits:async()=>[],theme:()=> 'llm',onStatus:status,
    now:()=>0,metadata:()=>({roundIndex:1,dealerIndex:0})})
  const v=input();v.wallCount=8
  for(let n=0;n<3;n++){v.window!.id=`w${n}`;expect(await service.decide(v,()=>true)).not.toBeNull()}
  expect(calls.map(c=>c.reasoning)).toEqual([true,true,false])
  expect(calls[0].config.timeoutMs).toBe(40_000)
  expect(service.stats.enhancedReasoningRequests).toBe(2)
  expect(status.mock.calls.some(c=>String(c[2]).startsWith('思考中 · 正在'))).toBe(true)
  const firstActive=status.mock.calls.find(c=>c[1]===true)
  expect(firstActive?.[2]).toBeUndefined()
  expect(firstActive?.[4]).toBe('话痨')
  expect(typeof firstActive?.[5]).toBe('string')
  expect(status.mock.calls.at(-1)?.[1]).toBe(false)
  v.window!.id='short';v.window!.deadlineAt=2000
  await service.decide(v,()=>true)
  expect(calls.at(-1).reasoning).toBe(false)
  expect(calls.at(-1).config.timeoutMs).toBe(1750)
})
it('feature preparation consumes time without accidentally disabling the configured thinking tier',async()=>{
  let now=0
  const calls:any[]=[]
  const service=createBloodFlowDecisions({provider:()=>provider,now:()=>now,
    waits:async()=>{now+=50;return []},request:async o=>{calls.push(o);return {choice:o.candidateIds[0],message:''}}})
  const v=input();v.wallCount=8
  await service.decide(v,()=>true)
  expect(calls[0].reasoning).toBe(true)
  expect(calls[0].config.timeoutMs).toBe(39950)
  expect(calls[0].deadlineMs).toBe(39950)
})
it('keeps the model own win line for the committed batch and clears on cancel', async () => {
  const request = vi.fn(async (o: any) => ({ choice: o.candidateIds[0], message: '这把拿下！' }))
  const service = createBloodFlowDecisions({ provider: () => provider, waits: async () => [], request, now: () => 0 })
  const v = input()
  v.ownActions = [{ kind: 'win' }, { kind: 'pass' }]
  expect(await service.decide(v, () => true)).toEqual({ kind: 'win' })
  const line = service.takeWinLine(v.window!.id, 0)
  expect(line?.text).toBe('这把拿下!')
  expect(line?.style).toBe('话痨')
  expect(typeof line?.voiceKey).toBe('string')
  expect(service.takeWinLine(v.window!.id, 0)).toBeNull()
})

it('falls back to the blood-flow moment line by win source when the model gives no usable speech', async () => {
  const request = vi.fn(async (o: any) => ({ choice: o.candidateIds[0], message: '' }))
  const service = createBloodFlowDecisions({ provider: () => provider, waits: async () => [], request, now: () => 0, theme: () => 'llm' })
  const v = input()
  v.ownActions = [{ kind: 'win' }, { kind: 'pass' }]
  const score = scorePatterns(['pinghu'], false, 'self-draw')
  v.ownScore = score
  expect(await service.decide(v, () => true)).toEqual({ kind: 'win' })
  const line = service.takeWinLine(v.window!.id, 0)
  // 此前每性格只有一句通用 win 台词（「胡。」「拿下！」），自摸与吃胡听起来一模一样。
  expect(BLOOD_FLOW_MOMENT_LINES['self-draw'][provider.style]).toContain(line?.text)
  expect(bloodFlowWinMomentLine({ source: 'self-draw', style: provider.style, ordinal: 1,
    tier: bloodFlowWinMomentTier(score), sequence: 0 })).toBe(line?.text)
  // 胡法不同 → 台词不同：点炮胡不会借用自摸语气。
  expect(line?.text).not.toBe(bloodFlowWinMomentLine({ source: 'discard', style: provider.style, ordinal: 1, sequence: 0 }))
})

it('cancellation clears thinking even when a provider never settles its promise',async()=>{
  const status=vi.fn(),request=vi.fn((o:any)=>{o.onReasoningProgress();return new Promise<any>(()=>{})})
  const service=createBloodFlowDecisions({provider:()=>provider,waits:async()=>[],request,theme:()=> 'llm',onStatus:status})
  const v=input();v.wallCount=8
  const pending=service.decide(v,()=>true)
  await vi.waitFor(()=>expect(request).toHaveBeenCalledOnce())
  service.cancel()
  expect(await pending).toBeNull()
  await vi.waitFor(()=>expect(status.mock.calls.at(-1)?.[1]).toBe(false))
  expect(service.stats.successes).toBe(0)
})
