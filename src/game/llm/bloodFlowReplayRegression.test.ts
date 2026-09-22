import { describe,expect,it } from 'vitest'
import { buildBloodFlowDecisionInput,bloodFlowDecisionPlan } from './bloodFlowDecisionInput'
import { bloodFlowDecisionPrompt } from './bloodFlowRuntime'
import { BLOOD_FLOW_LLM_AI } from '../variants/lotus/bloodFlow/config'
import type { BloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import early from './fixtures/bloodFlow-c93b3ed8/round-1-window-83-2.json'
import cheap from './fixtures/bloodFlow-c93b3ed8/round-3-window-130-1.json'
import orphan from './fixtures/bloodFlow-c93b3ed8/round-3-window-173-2.json'
import late from './fixtures/bloodFlow-c93b3ed8/round-4-window-263-3.json'
const cases=[early,cheap,orphan,late]
describe('c93b3ed8 public-seat regression',()=>{
  it.each(cases)('preserves legal win and public-only inputs at $window.id',raw=>{
    const view=structuredClone(raw) as unknown as BloodFlowSeatView
    expect(view.players.filter(p=>p.seat!==view.seat).every(p=>p.hand.length===0)).toBe(true)
    expect('wall' in view).toBe(false)
    const built=buildBloodFlowDecisionInput(view,'audit',{},BLOOD_FLOW_LLM_AI)
    expect(built.candidates.some(c=>c.action.kind==='win')).toBe(true)
    expect(built.collapsedActions.some(c=>c.action.kind==='win')).toBe(false)
    const plan=bloodFlowDecisionPlan(view,BLOOD_FLOW_LLM_AI)
    expect(built.candidates.find(c=>c.id===built.request.engineSuggestion)?.action).toEqual(plan.recommended)
  })
  it('gives the model comparable fixed-hand gross totals and preserves the any-wait alternative',()=>{
    const view=structuredClone(early) as unknown as BloodFlowSeatView
    const built=buildBloodFlowDecisionInput(view,'early',{},BLOOD_FLOW_LLM_AI)
    const win=built.candidates.find(c=>c.action.kind==='win')!
    expect(win.features.ev?.income).toMatchObject({scope:'fixed-hand-gross',immediate:120,excludes:['opponent-payments','future-hand-improvements']})
    const any=built.candidates.filter(c=>c.features.ev?.reform?.anyWait)
    expect(any.length).toBeGreaterThan(0)
    for(const c of [win,...any]){
      const i=c.features.ev!.income!
      expect(i.total).toBe(i.immediate+i.future)
      expect(i.horizonOwnDraws).toBe(BLOOD_FLOW_LLM_AI.chainHorizon)
    }
  })
  it('does not advertise the qwen hand as a completed orphan route',()=>{
    const b=buildBloodFlowDecisionInput(structuredClone(orphan) as unknown as BloodFlowSeatView,'orphan',{},BLOOD_FLOW_LLM_AI)
    expect(b.bigHandRoute).toBeNull()
  })
  it('keeps late win/pass choice despite a large score deficit',()=>{
    const prompt=bloodFlowDecisionPrompt(structuredClone(late) as unknown as BloodFlowSeatView,[],'late','稳健',{},'稳健',BLOOD_FLOW_LLM_AI)
    expect(prompt.variables.bigHandRoute?.committed).toBe(false)
    expect(prompt.variables.ruleSummary).toContain('落后不增加摸牌机会')
    expect(prompt.messages.system).toContain('未计对手付款及未来再次改张')
    expect(prompt.messages.system).not.toContain('message 必须简述理由')
  })
})

it('does not present skipped three-shanten enumeration as zero effective tiles',()=>{
  const v=structuredClone(early) as unknown as BloodFlowSeatView
  v.players[v.seat].hand=['p3','m1','m3','m4','m7','p2','p9','p9','s9','west','red','green','green','p1']
  v.players[v.seat].drawnTileIndex=13
  v.ownScore=null
  v.ownActions=v.players[v.seat].hand.map((_,index)=>({kind:'discard',index}))
  const b=buildBloodFlowDecisionInput(v,'uncomputed',{},BLOOD_FLOW_LLM_AI)
  const distant=b.candidates.filter(c=>c.features.shanten!=='n/a'&&c.features.shanten>2)
  expect(distant.length).toBeGreaterThan(0)
  expect(distant.every(c=>c.features.ukeire==='n/a'&&c.features.effectiveTiles==='n/a')).toBe(true)
})
