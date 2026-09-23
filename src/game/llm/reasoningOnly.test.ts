import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {requestLlmDecision,testLlmConnection} from './client'
import {requestPreparedDecision} from './preparedDecision'
import {ConditionalReasoningCoordinator,DEFAULT_CONDITIONAL_REASONING} from './conditionalReasoning'
import {resetReasoningBudgetForTests} from './reasoningBudget'
import type {LlmProviderConfig} from './config'
const config:LlmProviderConfig={providerType:'qwen',model:'qwen3-vl-235b-a22b-thinking',baseUrl:'https://model.example.test/v1',apiKey:'synthetic-only',style:'稳健',timeoutMs:40000}
const messages={system:'Synthetic decision',user:'Choose A0'}
function response(choice='A0',finish='stop',stream=true){
  const content=JSON.stringify({choice,message:'收到。'})
  return stream?new Response([
    'data: '+JSON.stringify({choices:[{delta:{reasoning_content:'synthetic marker: {"choice":"WRONG"}'}}]}),
    'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:finish}]}),
    'data: [DONE]',
  ].join('\n\n')+'\n\n',{headers:{'Content-Type':'text/event-stream'}})
  :new Response(JSON.stringify({choices:[{message:{reasoning_content:'synthetic marker',content},finish_reason:finish}]}),{headers:{'Content-Type':'application/json'}})
}
beforeEach(resetReasoningBudgetForTests)
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
it.each([true,false])('accepts final actions from a reasoning-only model with stream=%s',async stream=>{
  let body:any
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{body=JSON.parse(init.body);return response('A0','stop',stream)}))
  await expect(requestLlmDecision({config,messages,candidateIds:['A0']})).resolves.toMatchObject({choice:'A0'})
  expect(body.enable_thinking).toBeUndefined()
  expect(body.max_tokens).toBeGreaterThanOrEqual(8192)
})
it('uses intrinsic thinking without conditional admission and reports thinking lifecycle',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response()))
  const coordinator=new ConditionalReasoningCoordinator({...DEFAULT_CONDITIONAL_REASONING,enabled:false}),admit=vi.spyOn(coordinator,'admit'),status=vi.fn()
  const stats:any={requests:0}
  const result=await requestPreparedDecision({config,messages,decision:{candidates:[{id:'A0'}]} as any,seat:2,stats,reasoning:coordinator,onStatus:status,budgetMs:40000})
  expect(result.choice).toBe('A0')
  expect(admit).not.toHaveBeenCalled()
  expect(stats.thinkingRequests).toBe(1)
  expect(stats.enhancedReasoningRequests??0).toBe(0)
  expect(status.mock.calls[0][0]).toBe(true)
  expect(status.mock.calls.at(-1)?.[0]).toBe(false)
})
it('pure-thinking connection probe checks a final whitelisted action instead of accepting truncation',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response('PING','length')))
  await expect(testLlmConnection(config)).resolves.toMatchObject({ok:false})
  vi.stubGlobal('fetch',vi.fn(async()=>response('PING')))
  await expect(testLlmConnection(config)).resolves.toMatchObject({ok:true})
})

it('keeps explicit non-thinking validation strict for switchable models',async()=>{
  let body:any
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{body=JSON.parse(init.body);return response()}))
  await expect(requestLlmDecision({config:{...config,model:'qwen3.5-flash'},messages,candidateIds:['A0']})).rejects.toMatchObject({kind:'reasoning'})
  expect(body.enable_thinking).toBe(false)
})
it('does not read a candidate out of the reasoning field when final content is empty',async()=>{
  const fetch=vi.fn(async()=>new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'{"choice":"A0"}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}))
  vi.stubGlobal('fetch',fetch)
  await expect(requestLlmDecision({config,messages,candidateIds:['A0']})).rejects.toMatchObject({kind:'parse'})
  expect(fetch).toHaveBeenCalledTimes(2) // Existing single semantic retry, never execute hidden reasoning.
})
it('rejects illegal final actions after the existing one semantic retry',async()=>{
  const fetch=vi.fn(async()=>response('ILLEGAL'))
  vi.stubGlobal('fetch',fetch)
  await expect(requestLlmDecision({config,messages,candidateIds:['A0']})).rejects.toMatchObject({kind:'parse'})
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('grows the capped reasoning budget after truncation without immediate retries',async()=>{
  const bodies:any[]=[]
  const fetch=vi.fn(async(_url,init)=>{bodies.push(JSON.parse(init.body));return response('A0',bodies.length===1?'length':'stop')})
  vi.stubGlobal('fetch',fetch)
  await expect(requestLlmDecision({config,messages,candidateIds:['A0']})).rejects.toMatchObject({kind:'length'})
  expect(fetch).toHaveBeenCalledTimes(1)
  await expect(requestLlmDecision({config,messages,candidateIds:['A0']})).resolves.toMatchObject({choice:'A0'})
  expect(bodies[0].max_tokens).toBe(8192)
  expect(bodies[1].max_tokens).toBe(16384)
  expect(bodies[1].response_format).toBeUndefined()
})
it.each(['qwen/qwen3-vl-235b-a22b-thinking','qwq-plus'])('supports recognized pure-thinking aliases %s',async model=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response()))
  await expect(requestLlmDecision({config:{...config,model},messages,candidateIds:['A0']})).resolves.toMatchObject({choice:'A0'})
})
it('respects an authority deadline even when the user disables the provider timeout',async()=>{
  const request=vi.fn(async()=>({choice:'A0',message:''}))
  await requestPreparedDecision({config:{...config,timeoutEnabled:false},messages,decision:{candidates:[{id:'A0'}]} as any,seat:2,stats:{requests:0} as any,
    reasoning:new ConditionalReasoningCoordinator({...DEFAULT_CONDITIONAL_REASONING,enabled:false}),request,budgetMs:Infinity,remainingAuthorityMs:1500})
  const sent=(request.mock.calls as any)[0][0]
  expect(sent.config.timeoutEnabled).toBe(true)
  expect(sent.config.timeoutMs).toBe(1500)
  expect(sent.deadlineMs).toBeUndefined()
})
it('does not invent a 40-second conditional-thinking cap when timeouts are disabled',async()=>{
  const request=vi.fn(async()=>({choice:'A0',message:''}))
  await requestPreparedDecision({config:{...config,timeoutEnabled:false},messages,decision:{candidates:[{id:'A0'}]} as any,seat:2,stats:{requests:0} as any,
    reasoning:new ConditionalReasoningCoordinator({...DEFAULT_CONDITIONAL_REASONING,enabled:false}),request,budgetMs:Infinity})
  const sent=(request.mock.calls as any)[0][0]
  expect(sent.config.timeoutEnabled).toBe(false)
  expect(sent.config.timeoutMs).toBe(Infinity)
  expect(sent.deadlineMs).toBeUndefined()
})
it('times out a real client request at the configured deadline',async()=>{
  vi.useFakeTimers()
  vi.stubGlobal('fetch',vi.fn((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}))))
  const result=expect(requestLlmDecision({config:{...config,timeoutMs:50},messages,candidateIds:['A0']})).rejects.toMatchObject({kind:'timeout'})
  await vi.advanceTimersByTimeAsync(51)
  await result
})
it('supports external cancellation while intrinsic reasoning is running',async()=>{
  const controller=new AbortController()
  vi.stubGlobal('fetch',vi.fn((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}))))
  const result=expect(requestLlmDecision({config:{...config,timeoutEnabled:false},messages,candidateIds:['A0'],signal:controller.signal})).rejects.toMatchObject({kind:'timeout'})
  controller.abort()
  await result
})
it('a pure-thinking probe rejects non-whitelisted final answers and missing final content',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response('OTHER')))
  await expect(testLlmConnection(config)).resolves.toMatchObject({ok:false})
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'synthetic-only'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})))
  await expect(testLlmConnection(config)).resolves.toMatchObject({ok:false})
})

import {createBloodFlowDecisions} from './bloodFlowRuntime'
import {BloodFlowEngine} from '../variants/lotus/bloodFlow/engine'
import {bloodFlowSeatView} from '../variants/lotus/bloodFlow/seatView'
import {seededRandom} from '../variants/lotus/bloodFlow/simulation'
import {BLOOD_FLOW_LLM_AI} from '../variants/lotus/bloodFlow/config'
it('records an actual blood-flow action as model success and submits it to the authority',async()=>{
  const engine=new BloodFlowEngine({authorityEpoch:'pure-test',roundId:'test',dealer:2,random:seededRandom(23),now:()=>0})
  const view=bloodFlowSeatView(engine,2)
  const source=vi.fn(),finished=vi.fn()
  vi.stubGlobal('fetch',vi.fn(async()=>response('A0')))
  const service=createBloodFlowDecisions({provider:()=>({...config,id:'pure',name:'pure'}),waits:async()=>[],now:()=>0,aiConfig:BLOOD_FLOW_LLM_AI,
    analysis:{source,candidates:vi.fn(),promptTemplate:vi.fn(),attemptStarted:vi.fn(()=>'attempt'),attemptFinished:finished} as any})
  const action=await service.decide(view,()=>true)
  expect(action).not.toBeNull()
  expect(source).toHaveBeenCalledWith(expect.objectContaining({source:'model'}))
  expect(finished).toHaveBeenCalledWith('attempt',expect.objectContaining({outcome:'success'}))
  expect(service.stats.successes).toBe(1)
  expect(service.stats.fallbacks).toBe(0)
  expect(engine.submit(engine.command(2,action!))).toBe(true)
  service.cancel()
})


it('does not invent an enhanced tier for DashScope Kimi K3 but boosts GLM when needed', async () => {
  const dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  for (const [model, expected] of [
    ['kimi-k3', false], ['kimi-k2.7-code', false],
    ['MiniMax-M2.5', false], ['MiniMax-M2.1', false],
    ['glm-5.3', true], ['glm-4.6v', true],
  ] as const) {
    const coordinator = new ConditionalReasoningCoordinator(DEFAULT_CONDITIONAL_REASONING)
    const admit = vi.spyOn(coordinator, 'admit').mockReturnValue({ enabled: true, reasons: ['audit'] } as never)
    const request = vi.fn(async () => ({ choice: 'A0', message: '' }))
    await requestPreparedDecision({
      config: { ...config, providerType: 'qwen', baseUrl: dash, model },
      messages, decision: { candidates: [{ id: 'A0' }] } as never, seat: 2,
      stats: { requests: 0 } as never, reasoning: coordinator, request,
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect((request.mock.calls as any)[0][0].reasoning).toBe(expected)
    expect(admit).toHaveBeenCalledTimes(expected ? 1 : 0)
  }
})
