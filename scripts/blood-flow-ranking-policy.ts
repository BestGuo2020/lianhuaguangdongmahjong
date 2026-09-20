import type {BloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
import {visibleTiles} from '../src/game/variants/lotus/bloodFlow/seatView'
import type {BloodFlowAiConfig} from '../src/game/variants/lotus/bloodFlow/config'
import type {ConditionalRonModel} from '../src/game/variants/lotus/bloodFlow/conditionalRon'
import {forecastConditionalIncome} from '../src/game/variants/lotus/bloodFlow/conditionalRon'
import {decideBloodFlowActionEv} from '../src/game/variants/lotus/bloodFlow/ai'
import {bloodFlowEvContext} from '../src/game/variants/lotus/bloodFlow/evContext'

/** Offline ranking-only intervention. Keep source-v2's decision unless BOTH
 * frozen policies already choose a qualified first-win reform discard. */
export function rankingDecision(view:BloodFlowSeatView,base:BloodFlowAiConfig,model:ConditionalRonModel,ensemble:readonly ConditionalRonModel[]){
  const original=decideBloodFlowActionEv(view,base)
  const fallback={original,raw:original,robust:original,eligible:false}
  if(view.public.seats[view.seat].locked||view.window?.kind!=='turn'||view.window.source.kind!=='draw'
    ||!view.ownActions.some(a=>a.kind==='win')||original?.kind!=='discard')return fallback
  const config={...base,conditionalRon:model},proposed=decideBloodFlowActionEv(view,config)
  if(proposed?.kind!=='discard'||proposed.index===original.index)return fallback
  if(view.players[view.seat].hand[proposed.index]===view.players[view.seat].hand[original.index])return fallback
  const oldEv=bloodFlowEvContext(view,base),newEv=bloodFlowEvContext(view,config)
  const old=oldEv.reformCandidates.find(c=>c.index===original.index)
  const oldNew=newEv.reformCandidates.find(c=>c.index===original.index)
  const next=newEv.reformCandidates.find(c=>c.index===proposed.index)
  if(!old||!oldNew||!next||old.ev<oldEv.winEv*base.reformGainRatio||next.ev<newEv.winEv*base.reformGainRatio)return fallback
  const player=view.players[view.seat],visible=visibleTiles(view),locked=view.public.seats.map(s=>s.locked)
  const oldHand=player.hand.filter((_,i)=>i!==original.index),newHand=player.hand.filter((_,i)=>i!==proposed.index)
  const differences=ensemble.map(m=>{
    const value=(hand:typeof oldHand)=>forecastConditionalIncome(hand,player.melds,view.jokers,visible,view.wallCount,base.chainHorizon,4,
      base.opportunityCalibration!,view.seat,locked,m)
    return value(newHand)-value(oldHand)
  }).sort((a,b)=>a-b)
  const lower=differences[Math.floor(differences.length*.05)]??Number.NEGATIVE_INFINITY
  const gap=next.ev-oldNew.ev,relativeGap=gap/Math.max(1,Math.abs(oldNew.ev))
  // 5% is a predeclared engineering deadband, NOT a statistical confidence bound.
  // Sampling only training parameters cannot account for model bias or tail losses.
  const accept=lower>0&&relativeGap>=.05
  return {original,raw:proposed,robust:accept?proposed:original,eligible:true,
    gap,relativeGap,lower,positiveFraction:differences.filter(d=>d>0).length/differences.length,
    oldValue:old.ev,newOldValue:oldNew.ev,newValue:next.ev,parameterStable:lower>0,accept}
}
