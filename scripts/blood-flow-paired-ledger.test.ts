import {it,expect} from 'vitest'
import {readFileSync,readdirSync} from 'node:fs'
import {deserialize} from 'node:v8'
import type {BloodFlowEngine} from '../src/game/variants/lotus/bloodFlow/engine'
import {pointLedger,windowOutcome,actualOwnDraw} from './blood-flow-paired-window'
import type {BloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
it('does not count the synthetic draw source on a chi/peng discard turn',()=>{
  const view={seat:0,window:{kind:'turn',source:{kind:'draw',id:'post-peng'}},players:[{drawnTileIndex:-1}]} as unknown as BloodFlowSeatView
  expect(actualOwnDraw(view,0)).toBe(false)
  view.players[0].drawnTileIndex=10
  expect(actualOwnDraw(view,0)).toBe(true)
})
it('separates multi-winner immediate payment, later discard cost, other payments and kong income',()=>{
  const win=(kind:string,seat:number,id:string,deltas:number[])=>({kind:'win',batch:{source:{kind,seat,id},winners:deltas.map(value=>({deltas:[value,0,0,0]}))}})
  const e={ledger:[
    win('draw',0,'old',[999]), // before the selected window: excluded
    win('discard',0,'forced',[-20,-30]),
    win('draw',1,'other',[-10]),
    win('draw',0,'own',[180]),
    win('discard',0,'later',[-40]),
    {kind:'kong',deltas:[30,0,0,0]},{kind:'kong',deltas:[-10,0,0,0]},
  ]} as unknown as BloodFlowEngine
  expect(pointLedger(e,0,1,'forced')).toEqual({gross:180,discardPaid:90,otherWinPaid:10,kongNet:20,immediateDiscardPaid:50,net:100})
})
it.skipIf(process.env.BF_PAIR_CHECKPOINTS!=='1')('replays identical forced actions with identical walls exactly',()=>{
  const dir='work/blood-flow-paired/310001'
  const name=readdirSync(dir).filter(n=>n.endsWith('-plan.json')).sort()[0]
  if(!name)throw new Error('Training checkpoint required')
  const plan=JSON.parse(readFileSync(`${dir}/${name}`,'utf8')),checkpoint=deserialize(readFileSync(`${dir}/seed-${plan.seed}.v8`))
  const a=windowOutcome(checkpoint,plan.seat,plan.old.index,0,700003)
  const b=windowOutcome(checkpoint,plan.seat,plan.old.index,0,700003)
  expect(a).toEqual(b);expect(a.ownDraws).toBeLessThanOrEqual(8)
},120_000)
