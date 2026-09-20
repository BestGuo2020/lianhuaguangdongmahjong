import { expect, it } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { forecastWinIncome } from '../src/game/variants/lotus/bloodFlow/incomeForecast'
import { bloodFlowEvContext } from '../src/game/variants/lotus/bloodFlow/evContext'
import type { BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import type { TileType, Meld } from '../src/game/core/contracts/types'
import { boundedSearch, forecastPolicy, FORECAST_CONFIG } from './blood-flow-bounded-search'
import { panelCurrent, panelPair, PANEL_CURRENT_CONFIG, type PanelPair, type PanelId } from './blood-flow-opponent-panel'
import { clusterSummary } from './blood-flow-counterfactual'

const output = 'work/blood-flow-forecast'
it('replays all published score discrepancies and measures public-input search', () => {
  const audit = JSON.parse(readFileSync('docs/blood-flow/records/static-score-audit-2026-09-20.json', 'utf8')) as {
    concealed: TileType[]; melds: Meld[]; jokers: TileType[];
    matrix: { tile: TileType; 'self-draw': {exactTotal:number}; discard: {exactTotal:number} }[]
  }[]
  let comparisons = 0
  for (const entry of audit) for (const cell of entry.matrix) for (const source of ['self-draw', 'discard'] as const) {
    expect(forecastWinIncome(entry.concealed, entry.melds, entry.jokers, cell.tile, source)).toBe(cell[source].exactTotal)
    comparisons++
  }
  const data = JSON.parse(readFileSync('docs/blood-flow/records/search-public-inputs-2026-09-20.json','utf8')) as {
    inputs: { caseId: string; view: BloodFlowSeatView }[]
  }
  const rows = data.inputs.map(({ caseId, view }) => {
    const before = JSON.stringify(view), start = performance.now()
    const legacy = bloodFlowEvContext(view, PANEL_CURRENT_CONFIG)
    const forecast = bloodFlowEvContext(view, FORECAST_CONFIG)
    const forecastMs = performance.now() - start, searchStart = performance.now()
    const search = boundedSearch(view), searchMs = performance.now() - searchStart
    expect(JSON.stringify(view)).toBe(before)
    expect(search.nodes).toBeLessThanOrEqual(68)
    expect(view.ownActions).toContainEqual(search.action)
    return { caseId, legacy: legacy.chainAfterWin, forecast: forecast.chainAfterWin, forecastMs, searchMs, search }
  })
  mkdirSync(output, {recursive:true})
  writeFileSync(`${output}/audit.json`, JSON.stringify({comparisons,rows},null,2))
}, 120_000)

function fingerprint() {
  const paths: string[] = []
  const visit = (dir: string) => { for (const item of readdirSync(dir, {withFileTypes:true})) {
    const path = join(dir,item.name)
    if (item.isDirectory()) visit(path); else if (path.endsWith('.ts')) paths.push(path)
  } }
  visit('src/game')
  paths.push(...['bounded-search','forecast-validation.test','opponent-panel','counterfactual'].map(n=>`scripts/blood-flow-${n}.ts`))
  const hash = createHash('sha256')
  for (const path of paths.sort()) hash.update(path).update(readFileSync(path))
  return hash.digest('hex')
}

it.skipIf(process.env.BF_FORECAST_RUN !== '1')('compares full East matches on fresh seeds', () => {
  const variant = process.env.BF_FORECAST_VARIANT ?? 'forecast'
  const panel = (process.env.BF_FORECAST_PANEL ?? 'mixed') as PanelId
  const from = Number(process.env.BF_FORECAST_FROM ?? 260001), seeds = Number(process.env.BF_FORECAST_SEEDS ?? 4)
  if (!['forecast','search'].includes(variant) || !['mixed','defensive'].includes(panel)
    || !Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(seeds) || seeds < 1 || seeds > 64) throw new Error('Invalid run')
  const dir = `${output}/${variant}-${panel}-${from}`
  if (existsSync(dir)) throw new Error('Fresh run required')
  mkdirSync(dir,{recursive:true})
  const hash = fingerprint(), times: number[] = [], expandedTimes: number[] = [], started = Date.now()
  let expanded = 0, promotions = 0, maxNodes = 0
  const control = variant === 'forecast' ? panelCurrent : forecastPolicy
  const candidate = (view: BloodFlowSeatView) => {
    const start = performance.now()
    if (variant === 'forecast') { const result = forecastPolicy(view); times.push(performance.now()-start); return result }
    const result = boundedSearch(view), elapsed = performance.now()-start
    times.push(elapsed)
    if (result.nodes) { expanded++; expandedTimes.push(elapsed); maxNodes = Math.max(maxNodes,result.nodes) }
    if (result.value !== undefined && result.action?.kind === 'discard') promotions++
    return result.action
  }
  const metadata = {variant,panel,from,seeds,sourceFingerprint:hash,forecastConfig:FORECAST_CONFIG,
    controlConfig:variant==='forecast'?PANEL_CURRENT_CONFIG:FORECAST_CONFIG,
    scope:'Paired full 4-round East matches, four focal seats, fixed synthetic opponents, no hidden information in policies; pilot, not promotion evidence.'}
  writeFileSync(`${dir}/metadata.json`,JSON.stringify(metadata,null,2))
  const rows: PanelPair[] = []
  for (let seed=from;seed<from+seeds;seed++) {
    const batch = ([0,1,2,3] as const).map(seat=>panelPair(panel,seed,seat,4,true,candidate,control,false))
    rows.push(...batch)
    writeFileSync(`${dir}/seed-${seed}.json`,JSON.stringify(batch,null,2))
    writeFileSync(`${dir}/progress.json`,JSON.stringify({seeds:seed-from+1,elapsedSeconds:(Date.now()-started)/1000,expanded,promotions}))
  }
  expect(fingerprint()).toBe(hash)
  const quantile = (values:number[],q:number) => [...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))] ?? 0
  writeFileSync(`${dir}/summary.json`,JSON.stringify({metadata,elapsedSeconds:(Date.now()-started)/1000,
    delta:clusterSummary(rows.map(r=>({seed:r.seed,value:r.delta}))),changedMatches:rows.filter(r=>r.changed).length,
    expanded,promotions,maxNodes,decisions:times.length,p95Ms:quantile(times,.95),maxMs:quantile(times,1),
    expandedP95Ms:quantile(expandedTimes,.95)},null,2))
}, 7_200_000)
