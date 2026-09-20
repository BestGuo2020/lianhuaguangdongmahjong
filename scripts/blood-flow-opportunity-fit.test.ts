import { it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { forecastSourceComponents } from '../src/game/variants/lotus/bloodFlow/incomeForecast'
import { visibleTiles } from '../src/game/variants/lotus/bloodFlow/seatView'
import { clusterSummary } from './blood-flow-counterfactual'
const mean=(v:number[])=>v.reduce((a,b)=>a+b,0)/v.length
it.skipIf(process.env.BF_FIT!=='1')('fits on training source seeds and evaluates held-out components',()=>{
  const load=(from:number)=>{
    const dir=`work/blood-flow-opportunity/observations-${from}`
    const done=JSON.parse(readFileSync(`${dir}/done.json`,'utf8'))
    return Array.from({length:done.rounds},(_,i)=>JSON.parse(readFileSync(`${dir}/seed-${from+i}.json`,'utf8'))).flat().map(a=>{
      const p=a.view.players[a.seat],hand=p.hand.filter((_:unknown,i:number)=>i!==p.drawnTileIndex)
      const c=forecastSourceComponents(hand,p.melds,a.view.jokers,visibleTiles(a.view),a.view.wallCount,8)
      return {seed:a.seed,seat:a.seat,wall:a.view.wallCount,self:a.self,ron:a.ron,ownDraws:a.ownDraws,opponentDiscards:a.opponentDiscards,...c}
    })
  }
  const train=[...load(270001),...load(270201)],holdout=[...load(270101),...load(270301)]
  const sum=(rows:any[],f:(a:any)=>number)=>rows.reduce((n,a)=>n+f(a),0)
  const drawScale=sum(train,a=>a.ownDraws)/sum(train,a=>a.own)
  const discardScale=sum(train,a=>a.opponentDiscards)/sum(train,a=>a.opponent)
  const selfX=(a:any)=>Math.min(8,a.wall,a.own*drawScale)*a.selfPerDraw
  const ronX=(a:any)=>a.opponent*discardScale*a.ronPerDiscard
  const ols=(x:(a:any)=>number,y:string)=>Math.max(0,sum(train,a=>x(a)*a[y])/Math.max(1,sum(train,a=>x(a)**2)))
  const calibration={drawScale,discardScale,selfYield:ols(selfX,'self'),ronYield:ols(ronX,'ron')}
  expect(Object.values(calibration).every(Number.isFinite)).toBe(true)
  const prediction=(a:any)=>selfX(a)*calibration.selfYield+ronX(a)*calibration.ronYield
  const errors=(rows:any[],predict:(a:any)=>number,target:(a:any)=>number)=>({
    mae:mean(rows.map(a=>Math.abs(predict(a)-target(a)))),rmse:Math.sqrt(mean(rows.map(a=>(predict(a)-target(a))**2))),
    predicted:mean(rows.map(predict)),observed:mean(rows.map(target))})
  const result={calibration,trainCount:train.length,holdoutCount:holdout.length,trainSeeds:56,holdoutSeeds:56,
    holdout:{oldSelfOnly:errors(holdout,a=>a.own*a.selfPerDraw,a=>a.self+a.ron),
      rawTwoSource:errors(holdout,a=>a.own*a.selfPerDraw+a.opponent*a.ronPerDiscard,a=>a.self+a.ron),
      calibrated:errors(holdout,prediction,a=>a.self+a.ron),
      self:errors(holdout,a=>selfX(a)*calibration.selfYield,a=>a.self),ron:errors(holdout,a=>ronX(a)*calibration.ronYield,a=>a.ron),
      oldDrawCount:errors(holdout,a=>a.own,a=>a.ownDraws),newDrawCount:errors(holdout,a=>Math.min(8,a.wall,a.own*drawScale),a=>a.ownDraws),
      oldDiscardCount:errors(holdout,a=>a.opponent,a=>a.opponentDiscards),newDiscardCount:errors(holdout,a=>a.opponent*discardScale,a=>a.opponentDiscards),
      maeGain:clusterSummary(holdout.map(a=>({seed:a.seed,value:Math.abs(a.own*a.selfPerDraw-a.self-a.ron)-Math.abs(prediction(a)-a.self-a.ron)})))},train,holdoutRows:holdout}
  writeFileSync('work/blood-flow-opportunity/calibration.json',JSON.stringify(result,null,2))
},300_000)
