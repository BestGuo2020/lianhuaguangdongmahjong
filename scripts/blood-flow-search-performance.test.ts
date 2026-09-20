import { it, expect } from 'vitest'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { boundedSearch } from './blood-flow-bounded-search'
import { clearForecastCache, forecastWinIncome } from '../src/game/variants/lotus/bloodFlow/incomeForecast'
import { evaluateWin } from '../src/game/variants/lotus/patterns/evaluate'
import type { BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { clearWaitingCacheForDiagnostics } from '../src/game/variants/lotus/bloodFlow/patternPotentials'
it('preserves canonical income across self-draw instance permutations and exact search pruning',()=>{
  const data=JSON.parse(readFileSync('docs/blood-flow/records/search-public-inputs-2026-09-20.json','utf8')) as {inputs:{caseId:string;view:BloodFlowSeatView}[]}
  const rows=data.inputs.map(({caseId,view})=>{
    const p=view.players[view.seat]
    for(let i=0;i<p.hand.length;i++) {
      const concealed=p.hand.filter((_,j)=>i!==j),tile=p.hand[i]
      const exact=(evaluateWin({concealed,melds:p.melds,jokers:view.jokers,winningTile:tile,source:'self-draw',opening:null})?.score.paymentPerPayer??0)*3
      expect(forecastWinIncome(concealed,p.melds,view.jokers,tile,'self-draw')).toBe(exact)
    }
    clearForecastCache(); clearWaitingCacheForDiagnostics()
    let start=performance.now();const reference=boundedSearch(view,false),referenceMs=performance.now()-start
    clearForecastCache(); clearWaitingCacheForDiagnostics()
    start=performance.now();const optimized=boundedSearch(view,true),optimizedMs=performance.now()-start
    expect(optimized.action).toEqual(reference.action)
    if(reference.value!==undefined)expect(optimized.value).toBeCloseTo(reference.value,8)
    expect(optimized.nodes).toBeLessThanOrEqual(reference.nodes)
    return {caseId,referenceMs,optimizedMs,reference,optimized}
  })
  mkdirSync('work/blood-flow-opportunity',{recursive:true})
  writeFileSync('work/blood-flow-opportunity/search-performance.json',JSON.stringify(rows,null,2))
},120_000)
