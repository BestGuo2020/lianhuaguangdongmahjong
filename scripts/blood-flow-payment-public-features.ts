import type {BloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
import {visibleTiles} from '../src/game/variants/lotus/bloodFlow/seatView'
import {bloodFlowSafetyExposure,bloodFlowOpponentRisk} from '../src/game/variants/lotus/bloodFlow/ai'
import {forecastWinIncome,unseenCounts} from '../src/game/variants/lotus/bloodFlow/incomeForecast'
import {forecastConditionalIncome,ronCategory} from '../src/game/variants/lotus/bloodFlow/conditionalRon'
import {WINDOW_BASE,WINDOW_MODEL} from './blood-flow-paired-window'

export const IMMEDIATE_FEATURES=['riskProxy/100','lockedOpponents/3','publicCopies/4','ownCopies/4',
  'sameSuitMeldTiles/12','maxPublicTier/3','wildcardFace','honor','terminal','wall/84'] as const
export const PAIR_FEATURES=[...IMMEDIATE_FEATURES,'grossH8/1000','tailGross/1000','selfWaitMass','wildcardsAfter/4'] as const

/** Inputs are the acting seat's legal information, never another concealed hand
 * or a state reached after the proposed discard. No outcome object is accepted. */
export function candidatePublicFeatures(view:BloodFlowSeatView,index:number){
  const player=view.players[view.seat],tile=player.hand[index],after=player.hand.filter((_,i)=>i!==index)
  const category=ronCategory(tile,view.jokers),opponents=view.players.filter((_,i)=>i!==view.seat)
  const publicTiles=[view.flipTile,...view.players.flatMap(p=>[...p.discards,...p.melds.flatMap(m=>m.tiles)]),...view.public.batches.map(b=>b.source.tile)]
  const tier=Math.max(0,...bloodFlowOpponentRisk(view,WINDOW_BASE).map(p=>p.tier))
  const sameSuit=opponents.flatMap(p=>p.melds.flatMap(m=>m.tiles)).filter(t=>
    /^[mps][1-9]$/.test(tile)?/^[mps][1-9]$/.test(t)&&t[0]===tile[0]:!(/^[mps][1-9]$/.test(t))).length
  const riskProxy=bloodFlowSafetyExposure(view,WINDOW_BASE)(tile)
  const visible=visibleTiles(view),locked=view.public.seats.map(s=>s.locked)
  const income=(horizon:number)=>forecastConditionalIncome(after,player.melds,view.jokers,visible,view.wallCount,horizon,4,
    WINDOW_BASE.opportunityCalibration,view.seat,locked,WINDOW_MODEL)
  const grossH8=income(8),tailGross=Math.max(0,income(Math.max(8,Math.ceil(view.wallCount/4)+1))-grossH8)
  let unseen=0,winning=0
  for(const {tile:incoming,count} of unseenCounts(visible))if(count){
    unseen+=count
    if(forecastWinIncome(after,player.melds,view.jokers,incoming,'self-draw')>0)winning+=count
  }
  const immediate=[riskProxy/100,opponents.filter(p=>view.public.seats[p.seat].locked).length/3,
    publicTiles.filter(t=>t===tile).length/4,player.hand.filter(t=>t===tile).length/4,sameSuit/12,tier/3,
    Number(category==='wildcard-face'),Number(category==='honor'),Number(category==='terminal'),view.wallCount/84]
  const paired=[...immediate,grossH8/1000,tailGross/1000,unseen?winning/unseen:0,
    after.filter(t=>t==='white'||view.jokers.includes(t)).length/4]
  // Fewer than nine wall tiles cannot supply a ninth real own draw, even with
  // replacement draws or skipped opponents. This is a physical bound, not fitted.
  const tailPaired=view.wallCount<=8?paired.map(()=>0):paired
  return {immediate,paired,tailPaired,riskProxy,grossH8,tailGross}
}
