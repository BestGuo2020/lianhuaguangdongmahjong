import type {TileType} from '../core/contracts/types'
import {tileName} from '../core/rules/tiles'
import {isWinningHand} from '../variants/lotus/lotusRules'
import {lotusDiscardCandidates} from '../variants/lotus/lotusAi'
import {waitingTilesCached} from '../variants/lotus/bloodFlow/patternPotentials'
import {visibleTiles,type BloodFlowSeatView} from '../variants/lotus/bloodFlow/seatView'
import type {BloodFlowAction} from '../variants/lotus/bloodFlow/state'

export interface BloodFlowWaitSummary {
 ready:boolean
 anyWait:boolean
 selfDrawOnly:boolean
 selfDrawWaitCount:number
 discardWaitCount:number
 selfDrawRemaining:number
 discardRemaining:number
}
export interface BloodFlowWaitComparison {
 before:BloodFlowWaitSummary
 /** Best reachable listening hand after the required discard, not a forced next action. */
 after:BloodFlowWaitSummary
 requiresDiscard:boolean
 bestDiscard?:string
 preservesAnyWait:boolean
 createsAnyWait:boolean
 breaksAnyWait:boolean
}

/** A waiting hand excludes our new draw and never includes someone else's claimed tile. */
export function bloodFlowStandingHand(view:BloodFlowSeatView):TileType[]|null {
 const p=view.players[view.seat],hand=[...p.hand]
 if(hand.length+3*p.melds.length===14 && view.window?.kind==='turn'
   && p.drawnTileIndex>=0 && p.drawnTileIndex<hand.length)hand.splice(p.drawnTileIndex,1)
 return hand.length+3*p.melds.length===13?hand:null
}

/** Exact structural legality, with source-specific joker rules; counts are not income/probabilities. */
export function bloodFlowWaitSummary(hand:readonly TileType[],meldCount:number,view:BloodFlowSeatView):BloodFlowWaitSummary {
 const self=waitingTilesCached(hand,meldCount,view.jokers)
 const anyWait=self.length===34
 const discard=anyWait?[]:self.filter(tile=>isWinningHand([...hand,tile],meldCount,view.jokers,[tile],['white']))
 const visible=visibleTiles(view)
 const remaining=(tiles:readonly TileType[])=>tiles.reduce((sum,tile)=>sum+Math.max(0,4-visible.filter(t=>t===tile).length),0)
 return {ready:self.length>0,anyWait,selfDrawOnly:anyWait,selfDrawWaitCount:self.length,discardWaitCount:discard.length,
   selfDrawRemaining:remaining(self),discardRemaining:remaining(discard)}
}

export function bloodFlowReadiness(view:BloodFlowSeatView) {
 const hand=bloodFlowStandingHand(view),p=view.players[view.seat]
 return {basis:p.hand.length+3*p.melds.length===14?'drawn-tile-removed' as const:'current-hand' as const,
   summary:hand?bloodFlowWaitSummary(hand,p.melds.length,view):null}
}

/** Advice only: never adds/removes a legal action or changes the local recommendation. */
export function bloodFlowClaimWaitComparison(view:BloodFlowSeatView,action:BloodFlowAction,before:BloodFlowWaitSummary|null):BloodFlowWaitComparison|null {
 if(!before||!view.window||view.window.kind==='turn')return null
 if(action.kind==='pass')return {before,after:before,requiresDiscard:false,preservesAnyWait:before.anyWait,createsAnyWait:false,breaksAnyWait:false}
 if(!['chi','peng'].includes(action.kind)||view.window.source.kind!=='discard')return null
 const p=view.players[view.seat],hand=[...p.hand],tile=view.window.source.tile
 const consumed=action.kind==='chi'?[...action.tiles]:[tile,tile]
 if(action.kind==='chi'){
   const claimed=consumed.indexOf(tile)
   if(claimed<0)return null
   consumed.splice(claimed,1)
 }
 for(const ownTile of consumed){const index=hand.indexOf(ownTile);if(index<0)return null;hand.splice(index,1)}
 if(hand.length+3*(p.melds.length+1)!==14)return null
 const options=lotusDiscardCandidates(hand,view.jokers).map(c=>({tile:c.tile,
   summary:bloodFlowWaitSummary(hand.filter((_,i)=>i!==c.index),p.melds.length+1,view)}))
 const best=options.sort((a,b)=>b.summary.selfDrawRemaining-a.summary.selfDrawRemaining
   ||b.summary.selfDrawWaitCount-a.summary.selfDrawWaitCount||b.summary.discardRemaining-a.summary.discardRemaining)[0]
 if(!best)return null
 const anyWaitReachable=options.some(c=>c.summary.anyWait)
 return {before,after:best.summary,requiresDiscard:true,bestDiscard:tileName(best.tile),
   preservesAnyWait:before.anyWait&&anyWaitReachable,createsAnyWait:!before.anyWait&&anyWaitReachable,
   breaksAnyWait:before.anyWait&&!anyWaitReachable}
}
