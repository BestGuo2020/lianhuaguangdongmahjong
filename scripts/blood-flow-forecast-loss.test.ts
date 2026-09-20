import { expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { panelPair, panelCurrent, PANEL_CURRENT_CONFIG } from './blood-flow-opponent-panel'
import { forecastPolicy, FORECAST_CONFIG } from './blood-flow-bounded-search'
import { bloodFlowEvContext } from '../src/game/variants/lotus/bloodFlow/evContext'
import type { BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'

it.skipIf(process.env.BF_FORECAST_LOSS !== '1')('reproduces both directions of forecast losses', () => {
  const cases = [{seed:261106,seat:3 as const,delta:-1900},{seed:261108,seat:1 as const,delta:-1830}]
  const results = cases.map(({seed,seat,delta}) => {
    let first: unknown = null
    const candidate = (view: BloodFlowSeatView) => {
      const chosen = forecastPolicy(view), old = panelCurrent(view)
      if (!first && JSON.stringify(chosen)!==JSON.stringify(old)) {
        expect(view.players.filter(p=>p.seat!==seat).every(p=>!p.hand.length)).toBe(true)
        const legacy = bloodFlowEvContext(view,PANEL_CURRENT_CONFIG), forecast = bloodFlowEvContext(view,FORECAST_CONFIG)
        first = {view:structuredClone(view),old,chosen,legacy,forecast}
      }
      return chosen
    }
    const result = panelPair('defensive',seed,seat,4,true,candidate,panelCurrent,false)
    expect(result.delta).toBe(delta)
    expect(first).not.toBeNull()
    return {seed,seat,result,first}
  })
  mkdirSync('work/blood-flow-forecast',{recursive:true})
  writeFileSync('work/blood-flow-forecast/loss-reproductions.json',JSON.stringify({
    scope:'Post-validation diagnostics, selected negative cases, not independent holdout. Public views only; provenance is offline and never passed to policy.',results},null,2))
}, 300_000)
