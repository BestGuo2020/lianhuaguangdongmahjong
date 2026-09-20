import { it, expect } from 'vitest'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { newRound, nextSeatToAct, submit } from './blood-flow-counterfactual'
import { panelCurrent, opponentFor } from './blood-flow-opponent-panel'
import type { BloodFlowEngine } from '../src/game/variants/lotus/bloodFlow/engine'

it.skipIf(process.env.BF_OBSERVE !== '1')('records source-separated income and actual opportunities', () => {
  const from = Number(process.env.BF_OBSERVE_FROM ?? 270001), rounds = Number(process.env.BF_OBSERVE_ROUNDS ?? 32)
  const dir = `work/blood-flow-opportunity/observations-${from}`
  if (existsSync(dir)) throw new Error('Fresh batch required')
  mkdirSync(dir,{recursive:true})
  for(let seed=from;seed<from+rounds;seed++) {
    const engine = newRound(seed), active = new Map<number, any>(), finished: any[] = []
    const close = (seat:number, e:BloodFlowEngine, beforeNinthDraw=false) => {
      const a=active.get(seat)
      if(!a)return
      let self=0,ron=0,kong=0
      for(const entry of e.ledger.slice(a.ledger)) {
        if(entry.kind==='kong'){kong+=entry.deltas[seat];continue}
        for(const w of entry.batch.winners)if(w.winner===seat) {
          if(w.score.source==='self-draw'||w.score.source==='kong-bloom')self+=w.deltas[seat]
          else ron+=w.deltas[seat]
        }
      }
      finished.push({...a,drawIds:undefined,self:self-a.immediate,ron,kong,
        opponentDiscards:e.discardActions.slice(a.discards).filter(d=>d.seat!==seat).length,
        wallConsumed:a.view.wallCount-e.wall.length-Number(beforeNinthDraw)})
      active.delete(seat)
    }
    const started = new Set<number>()
    let commands=0
    while(!engine.result) {
      if(++commands>2000)throw new Error('Stalled')
      const seat=nextSeatToAct(engine),view=bloodFlowSeatView(engine,seat),source=view.window!.source
      for(const [focal,a] of active)if(source.kind==='draw'&&!a.drawIds.has(source.id)) {
        a.drawIds.add(source.id)
        if(source.seat===focal) {
          if(a.ownDraws===8){close(focal,engine,true);continue}
          a.ownDraws++
        } else a.opponentDraws++
      }
      const policy=seat===0?panelCurrent:opponentFor('mixed',seed,0,seat)
      const action=policy(view)
      if(!action)throw new Error('Missing action')
      if(!started.has(seat)&&action.kind==='win'&&source.kind==='draw'&&!view.public.seats[seat].locked) {
        started.add(seat)
        active.set(seat,{seed,seat,view,ledger:engine.ledger.length,discards:engine.discardActions.length,
          immediate:(view.ownScore?.paymentPerPayer??0)*3,ownDraws:0,opponentDraws:0,drawIds:new Set([source.id])})
      }
      submit(engine,seat,action)
    }
    for(const seat of [...active.keys()])close(seat,engine)
    expect(finished.every(a=>a.self>=0&&a.ron>=0&&a.ownDraws<=8)).toBe(true)
    writeFileSync(`${dir}/seed-${seed}.json`,JSON.stringify(finished))
    writeFileSync(`${dir}/progress.json`,JSON.stringify({completed:seed-from+1,rounds}))
  }
  writeFileSync(`${dir}/done.json`,JSON.stringify({from,rounds,policy:'focal current; mixed synthetic opponents; all four seats observed',horizon:'before ninth own draw or end',split:'entire source seeds; caller assigns train/holdout'}))
},7_200_000)
