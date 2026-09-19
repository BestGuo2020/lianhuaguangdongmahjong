import { expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { deserialize } from 'node:v8'
import { restoreEngine } from './blood-flow-counterfactual'
import { bloodFlowSeatView, visibleTiles } from '../src/game/variants/lotus/bloodFlow/seatView'
import { bloodFlowSafetyExposure } from '../src/game/variants/lotus/bloodFlow/ai'
import { decideClaim } from '../src/game/variants/lotus/lotusAi'
import { waitingTiles } from '../src/game/variants/lotus/lotusRules'
import { patternPotentialEv } from '../src/game/variants/lotus/bloodFlow/patternPotentials'
import { MELD_FIXED_CONFIG } from './blood-flow-meld-projection-policy'
import { removeMatches } from '../src/game/core/rules/actions'

it.skipIf(process.env.BF_MP_CASE_READINESS !== '1')('explains readiness ordering in the saved cases without changing policy', () => {
  const rows=['1100001-peng','1100008-peng'].map(key=>{
    const {checkpoint,seat}=deserialize(readFileSync(`work/blood-flow-meld-counterfactual/screen-v1/${key}.bin`))
    const view=bloodFlowSeatView(restoreEngine(checkpoint),seat),p=view.players[seat],source=view.window!.source
    const projectedShapes: { handLength:number; meldCount:number; effectiveTiles:number }[]=[]
    const decision=decideClaim({hand:p.hand,melds:p.melds,exposedMelds:p.melds.length,jokers:view.jokers,
      tile:source.tile,from:source.seat,canPeng:true,canGang:false,chiOptions:[],claimMeldProjection:true,
      wallCount:view.wallCount,visibleTiles:visibleTiles(view),earlyRound:p.discards.length<2,
      upperLastDiscard:view.players[(seat+3)%4].discards.at(-1),
      publicTiles:[view.flipTile,...view.players.flatMap(player=>[...player.discards,...player.melds.flatMap(m=>m.tiles)]),...view.public.batches.map(b=>b.source.tile)],
      patternBonus:(hand,melds)=>{
        if(hand.length<p.hand.length)projectedShapes.push({handLength:hand.length,meldCount:melds.length,effectiveTiles:hand.length+3*melds.length})
        return patternPotentialEv(hand,melds,view.jokers,view.wallCount,MELD_FIXED_CONFIG.sevenPairsModel,MELD_FIXED_CONFIG)
      },
      safetyExposure:bloodFlowSafetyExposure(view,MELD_FIXED_CONFIG,visibleTiles(view))})
    const before=waitingTiles(p.hand,p.melds.length,view.jokers)
    expect(decision.kind).toBe('peng')
    const afterPeng=removeMatches(p.hand,source.tile,2)
    const index=decision.kind==='peng'?decision.discardIndex!:0
    const after=waitingTiles(afterPeng.filter((_,i)=>i!==index),p.melds.length+1,view.jokers)
    expect(projectedShapes.length).toBeGreaterThan(0)
    expect(projectedShapes.every(shape=>shape.effectiveTiles===13&&shape.meldCount===p.melds.length+1)).toBe(true)
    return {key,decision,beforeWaits:before,afterWaits:after,projectedShapes,
      note:'compareQuality prioritizes ready vs not-ready before comparing netScore; this diagnostic does not test any new policy.'}
  })
  writeFileSync('work/blood-flow-meld-projection/case-readiness.json',JSON.stringify(rows,null,2))
},30_000)
