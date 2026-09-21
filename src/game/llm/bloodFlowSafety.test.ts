import { expect, it, vi } from 'vitest'
import fixture from '../variants/lotus/bloodFlow/terminalSelfDraw.fixture.json'
import type { BloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import { createBloodFlowDecisions } from './bloodFlowRuntime'
import { BLOOD_FLOW_LLM_AI } from '../variants/lotus/bloodFlow/config'
import { LlmClientError } from './client'
import { quotaStatus } from './providerAvailability'
import type { LlmProviderPreset } from './config'

const view = () => { const v = structuredClone(fixture) as unknown as BloodFlowSeatView; v.window!.deadlineAt = Infinity; return v }
function sink() { return { candidates: vi.fn(), source: vi.fn(), attemptStarted: vi.fn(() => 'attempt'), attemptFinished: vi.fn(), promptTemplate: vi.fn() } }
it('takes the final self-draw before provider lookup or model calls and records local provenance', async () => {
  const input = view(), analysis = sink(), request = vi.fn(async () => ({ choice: 'A4', message: '听口宽些' })), provider = vi.fn(), waits = vi.fn()
  const service = createBloodFlowDecisions({provider,request,waits,analysis,aiConfig:BLOOD_FLOW_LLM_AI})
  expect(await service.decide(input, () => true)).toEqual({kind:'win'})
  expect(provider).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(waits).not.toHaveBeenCalled()
  expect(service.stats.requests).toBe(0)
  expect(analysis.source).toHaveBeenCalledWith(expect.objectContaining({source:'local-strategy',reason:'terminal-self-draw'}))
  expect(analysis.candidates).toHaveBeenCalled()
  expect(analysis.attemptStarted).not.toHaveBeenCalled()
  expect(await service.decide(input, () => false)).toBeNull()
})

it('does not apply the terminal short circuit to positive-wall draws or discard responses', async () => {
  const request = vi.fn(async () => ({choice:'A0',message:''}))
  const p:LlmProviderPreset={id:'bounds',name:'bounds',baseUrl:'https://bounds.test/v1',apiKey:'key',model:'bounds',style:'稳健',timeoutMs:40000}
  const service=createBloodFlowDecisions({provider:()=>p,request,waits:async()=>[]})
  const positive=view();positive.wallCount=1
  await service.decide(positive,()=>true)
  expect(request).toHaveBeenCalledTimes(1)
  const claim=view();claim.window={...claim.window!,kind:'win',source:{...claim.window!.source,kind:'discard',seat:0}}
  claim.players[claim.seat].drawnTileIndex=-1;claim.ownActions=[{kind:'win'},{kind:'pass'}]
  await service.decide(claim,()=>true)
  expect(request).toHaveBeenCalledTimes(2)
})

it('records first quota fallback separately from suspended local decisions without repeated attempts', async () => {
  const p:LlmProviderPreset={id:'quota-runtime',name:'quota',baseUrl:'https://runtime-quota.test/v1',apiKey:'key',model:'quota-runtime',style:'稳健',timeoutMs:40000}
  const analysis=sink(), onQuotaPaused=vi.fn(), request=vi.fn(async()=>{throw new LlmClientError('quota','额度耗尽')})
  const service=createBloodFlowDecisions({provider:()=>p,request,waits:async()=>[],analysis,onQuotaPaused})
  const input=view();input.wallCount=20
  expect(await service.decide(input,()=>true)).not.toBeNull()
  expect(quotaStatus(p)).toBe('paused')
  expect(service.stats.fallbacks).toBe(1);expect(service.stats.successes).toBe(0)
  expect(analysis.source).toHaveBeenCalledWith(expect.objectContaining({source:'model-fallback',reason:'quota-exhausted'}))
  for(let i=0;i<3;i++){ input.window!.id=`next-${i}`;expect(await service.decide(input,()=>true)).not.toBeNull() }
  // A new round/service and different seat style still use the same connection pause.
  const second=createBloodFlowDecisions({provider:()=>({...p,style:'激进'}),request,waits:async()=>[],analysis,onQuotaPaused})
  expect(await second.decide(input,()=>true)).not.toBeNull()
  expect(request).toHaveBeenCalledTimes(1);expect(analysis.attemptStarted).toHaveBeenCalledTimes(1)
  expect(onQuotaPaused).toHaveBeenCalledTimes(1)
  expect(analysis.source).toHaveBeenLastCalledWith(expect.objectContaining({source:'local-strategy',reason:'quota-paused'}))
})
