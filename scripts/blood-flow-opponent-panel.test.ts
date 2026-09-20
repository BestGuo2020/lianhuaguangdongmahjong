import { expect,it } from 'vitest'
import { baseline,newRound,nextSeatToAct,submit } from './blood-flow-counterfactual'
import { panelCurrent,panelPair,opponentFor,calibrationTracker } from './blood-flow-opponent-panel'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'

it('rotates the mixed opponents relative to the focal seat without assigning a hidden-information policy',()=>{
  const a=[1,2,3].map(s=>opponentFor('mixed',1500001,0,s as 1|2|3))
  const b=[2,3,0].map(s=>opponentFor('mixed',1500001,1,s as 0|2|3))
  expect(new Set(a).size).toBe(3)
  expect(a).toEqual(b)
  expect(()=>opponentFor('mixed',1,0,0)).toThrow()
})

it('heterogeneous-table A/A has zero paired change, without assuming absolute score is zero',()=>{
  for(const seat of [0,1,2,3] as const){
    const pair=panelPair('mixed',1540001,seat,1,true,baseline,baseline,false)
    expect(pair.delta).toBe(0)
    expect(pair.currentNet).toBe(pair.controlNet)
    expect(pair.changed).toBe(false)
  }
},180_000)

it('paired prefix reuse agrees with full replay through a real policy divergence',()=>{
  for(let seed=1540002;seed<1540018;seed++){
    const fast=panelPair('legacy',seed,1,1,true)
    if(!fast.changed)continue
    const full=panelPair('legacy',seed,1,1,false)
    const {actualCommands:_fast,...a}=fast,{actualCommands:_full,...b}=full
    expect(a).toEqual(b)
    return
  }
  throw new Error('No nontrivial fixture found')
},240_000)

it('calibration records a bounded future-income target and retains payments separately',()=>{
  // A complete match need not contain a first self-draw win for a given seat.
  // Force an actually legal first self-draw in a fixture to exercise accounting, not the sample frequency.
  for(let seed=940001;seed<940017;seed++){
    const engine=newRound(seed)
    let tracker:ReturnType<typeof calibrationTracker>|null=null,steps=0
    while(!engine.result){
      if(++steps>2000)throw new Error('Fixture stalled')
      const seat=nextSeatToAct(engine),view=bloodFlowSeatView(engine,seat)
      let action=panelCurrent(view)!
      if(!tracker&&!view.public.seats[seat].locked&&view.window?.kind==='turn'&&view.ownActions.some(a=>a.kind==='win')){
        tracker=calibrationTracker('legacy',seed,seat,0);action={kind:'win'}
      }
      tracker?.before(engine,seat,view,action)
      submit(engine,seat,action)
    }
    if(!tracker)continue
    const row=tracker.finish(engine)!
    expect(row).not.toBeNull()
    expect(row.ownDrawsObserved).toBeLessThanOrEqual(8)
    expect(row.horizonGross).toBeGreaterThanOrEqual(0)
    expect(row.horizonGross).toBeLessThanOrEqual(row.fullRemainingGross)
    expect(row.horizonNet).toBe(row.horizonGross-row.horizonPayments+row.horizonKongNet)
    return
  }
  throw new Error('No accounting fixture found')
},180_000)
