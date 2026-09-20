import {expect,it} from 'vitest'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {BloodFlowEngine} from '../src/game/variants/lotus/bloodFlow/engine'
import {BLOOD_FLOW_CONFIG} from '../src/game/variants/lotus/bloodFlow/config'
import {bloodFlowSeatView,visibleTiles} from '../src/game/variants/lotus/bloodFlow/seatView'
import {bloodFlowEvContext} from '../src/game/variants/lotus/bloodFlow/evContext'
import {seededRandom} from '../src/game/variants/lotus/bloodFlow/simulation'
import {vector} from '../src/game/variants/lotus/bloodFlow/state'
import {nextSeatToAct,submit} from './blood-flow-counterfactual'
import {panelCurrent,opponentFor,PANEL_CURRENT_CONFIG,type CalibrationObservation} from './blood-flow-opponent-panel'
import {estimateWinIncome,waitingTilesCached} from '../src/game/variants/lotus/bloodFlow/patternPotentials'
import {evaluateWin} from '../src/game/variants/lotus/patterns/evaluate'

it.skipIf(process.env.BF_PANEL_EXPORT!=='1')('reconstructs public-only audit inputs for a later search study',()=>{
  const analysis=JSON.parse(readFileSync('work/blood-flow-opponent-panel/analysis-legacy-attack-defensive-mixed.json','utf8'))
  const rawWorst=analysis.observations.filter(o=>o.split==='holdout').sort((a,b)=>
    Math.abs(b.predictedChain-b.horizonGross)-Math.abs(a.predictedChain-a.horizonGross))
  const selected=[...analysis.calibration.auditWindows.slice(0,2),...rawWorst]
  const unique=new Set<string>()
  const targets:CalibrationObservation[]=selected.filter(o=>{
    const key=`${o.panel}/${o.seed}/${o.focal}/${o.windowId}`
    if(unique.has(key))return false;unique.add(key);return true
  }).slice(0,4)
  expect(targets.length).toBeGreaterThan(0)
  const inputs:unknown[]=[],index:unknown[]=[],scoreAudits:unknown[]=[]
  for(const target of targets){
    let scores=vector(()=>BLOOD_FLOW_CONFIG.initialScore),found=false
    const caseId=`public-${createHash('sha256').update(`${target.panel}/${target.seed}/${target.focal}/${target.windowId}`).digest('hex').slice(0,16)}`
    for(let round=0;round<=target.round&&!found;round++){
      const engine=new BloodFlowEngine({authorityEpoch:'opponent-panel',roundId:`${target.seed}/${round}`,
        dealer:(round%4) as 0|1|2|3,scores,random:seededRandom((Math.imul(target.seed,4)+round)>>>0),now:()=>0,winBeatMs:0,paced:false})
      let steps=0
      while(!engine.result){
        if(++steps>2000)throw new Error('Replay stalled')
        const seat=nextSeatToAct(engine),view=bloodFlowSeatView(engine,seat)
        const policy=seat===target.focal?panelCurrent:opponentFor(target.panel,target.seed,target.focal,seat)
        const action=policy(view)!
        if(round===target.round&&seat===target.focal&&view.window?.id===target.windowId){
          expect(action.kind).toBe('win')
          expect(view.wallCount).toBe(target.wall)
          expect(bloodFlowEvContext(view,PANEL_CURRENT_CONFIG).chainAfterWin).toBeCloseTo(target.predictedChain,6)
          expect(view.players.every(p=>p.seat===seat||p.hand.length===0)).toBe(true)
          // Bench round/source IDs encode the seed; remove it from planner-facing input too.
          const safe=JSON.parse(JSON.stringify(view,(_key,value)=>typeof value==='string'?value.replaceAll(String(target.seed),caseId):value))
          inputs.push({caseId,view:safe})
          index.push({caseId,panel:target.panel,seed:target.seed,focal:target.focal,round:target.round,windowId:target.windowId})
          const player=view.players[seat],locked=player.hand.filter((_,i)=>i!==player.drawnTileIndex),visible=visibleTiles(view)
          const matrix=waitingTilesCached(locked,player.melds.length,view.jokers).flatMap(tile=>{
            const remaining=Math.max(0,4-visible.filter(t=>t===tile).length)
            if(!remaining)return []
            const row={tile,remaining} as Record<string,unknown>
            for(const source of ['self-draw','discard'] as const){
              const estimate=estimateWinIncome([...locked,tile],player.melds,view.jokers,source,PANEL_CURRENT_CONFIG.sevenPairsModel)
              const exact=evaluateWin({concealed:locked,melds:player.melds,winningTile:tile,jokers:view.jokers,source,opening:null})
              row[source]={estimatedTotal:estimate.total,exactTotal:(exact?.score.paymentPerPayer??0)*(source==='self-draw'?3:1),
                exactPatterns:exact?.score.items.map(p=>p.label)??[],legal:Boolean(exact)}
            }
            return [row]
          })
          scoreAudits.push({caseId,wall:view.wallCount,concealed:locked,melds:player.melds,jokers:view.jokers,matrix,
            scope:'Public own-hand static scoring only. No future draws/opponent hands used; not a policy-strength experiment.'})
          found=true;break
        }
        submit(engine,seat,action)
      }
      scores=vector(s=>engine.players[s].score)
    }
    expect(found).toBe(true)
  }
  writeFileSync('work/blood-flow-opponent-panel/search-public-inputs.json',JSON.stringify({
    scope:'Public seat observations only; no future outcomes, opponent policy labels, original seeds, hidden hands or wall order. Selected audit/training cases, NOT an untouched validation set.',inputs},null,2))
  writeFileSync('work/blood-flow-opponent-panel/search-provenance.json',JSON.stringify({
    scope:'Replay index only. Must not be consumed by a decision policy. These source seeds are now used for analysis; validate a future search policy on new seeds.',index},null,2))
  writeFileSync('work/blood-flow-opponent-panel/static-score-audit.json',JSON.stringify(scoreAudits,null,2))
},240_000)
