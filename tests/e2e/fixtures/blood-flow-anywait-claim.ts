import {createBloodFlowDecisions} from '../../../src/game/llm/bloodFlowRuntime'
import {BLOOD_FLOW_LLM_AI} from '../../../src/game/variants/lotus/bloodFlow/config'
import type {BloodFlowSeatView} from '../../../src/game/variants/lotus/bloodFlow/seatView'
import raw from '../../../src/game/llm/fixtures/bloodFlow-48bd88a9/round-3-window-68-3.json'

const view=structuredClone(raw) as unknown as BloodFlowSeatView
view.window!.deadlineAt=Infinity
const service=createBloodFlowDecisions({
 provider:()=>({id:'fixture',name:'fixture',providerType:'custom',baseUrl:'https://model.example.test/v1',
   apiKey:'not-a-real-key',model:'fixture-model',style:'稳健',timeoutMs:40_000}),
 now:()=>0,aiConfig:BLOOD_FLOW_LLM_AI,
})
service.decide(view,()=>true).then(action=>{
 document.querySelector('#result')!.textContent=JSON.stringify(action)
},error=>{document.querySelector('#result')!.textContent=String(error)})
