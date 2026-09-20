import type { Meld,TileType } from '../../../core/contracts/types'
import { forecastWinIncome,forecastSourceComponents,normalOpportunities,unseenCounts,type OpportunityCalibration } from './incomeForecast'

export const RON_CATEGORIES = ['wildcard-face','honor','terminal','middle'] as const
export type RonCategory = typeof RON_CATEGORIES[number]
export type CategoryVector = Readonly<Record<RonCategory,number>>
export interface ConditionalRonModel {
  readonly version: 1
  /** Nonnegative relative propensities, normalized against CURRENT available mass. */
  readonly weights: Readonly<Record<string,CategoryVector>>
}
export function ronCategory(tile:TileType,jokers:readonly TileType[]):RonCategory {
  if(tile==='white'||jokers.includes(tile))return 'wildcard-face'
  if(!/^[mps][1-9]$/.test(tile))return 'honor'
  return tile.endsWith('1')||tile.endsWith('9')?'terminal':'middle'
}
export function ronValueBand(value:number) {
  return value<=0?'no-live-ron':value<=40?'low-1-40':value<=160?'mid-40-160':'high-over-160'
}
export function conditionalCategoryProbabilities(prior:CategoryVector,locked:boolean,band:string,model:ConditionalRonModel):CategoryVector {
  const weights=model.weights[`${locked}/${band}`]??model.weights[String(locked)]??model.weights.global
  const values=RON_CATEGORIES.map(c=>Math.max(0,prior[c])*(weights?Math.max(0,weights[c]):1))
  const total=values.reduce((n,v)=>n+v,0)
  if(!total)return prior
  return Object.fromEntries(RON_CATEGORIES.map((c,i)=>[c,values[i]/total])) as Record<RonCategory,number>
}

/** Current public opponent lock states are held fixed over the horizon. Category
 * composition is modeled; within-category faces still follow unseen mass.
 * No realized next discard, hidden hand, seed or evaluation label is accepted. */
export function forecastConditionalIncome(
  hand:readonly TileType[],melds:readonly Readonly<Meld>[],jokers:readonly TileType[],visible:readonly TileType[],
  wall:number,horizon:number,offset:number,calibration:OpportunityCalibration,
  viewer:number,locked:readonly boolean[],model:ConditionalRonModel,
) {
  const c=forecastSourceComponents(hand,melds,jokers,visible,wall,horizon,offset)
  const self=Math.min(horizon,wall,c.own*calibration.drawScale)*c.selfPerDraw*calibration.selfYield
  if(!c.opponent)return self
  const mass={ 'wildcard-face':0,honor:0,terminal:0,middle:0 },income={...mass}
  let unseen=0,winning=0,totalIncome=0
  for(const {tile,count} of unseenCounts(visible))if(count){
    const category=ronCategory(tile,jokers),value=forecastWinIncome(hand,melds,jokers,tile,'discard')
    unseen+=count;mass[category]+=count;income[category]+=count*value;totalIncome+=count*value
    if(value)winning+=count
  }
  if(!unseen)return self
  const prior=Object.fromEntries(RON_CATEGORIES.map(k=>[k,mass[k]/unseen])) as Record<RonCategory,number>
  const band=ronValueBand(winning?totalIncome/winning:0)
  const byStatus=[false,true].map(status=>{
    const probabilities=conditionalCategoryProbabilities(prior,status,band,model)
    return RON_CATEGORIES.reduce((n,k)=>n+probabilities[k]*(mass[k]?income[k]/mass[k]:0),0)
  })
  const consumed=normalOpportunities(wall,horizon,offset)
  let ron=0
  for(let position=1;position<=consumed.own+consumed.opponent;position++){
    const seat=((viewer-offset+position)%4+4)%4
    if(seat!==viewer)ron+=byStatus[Number(locked[seat])]
  }
  return self+ron*calibration.discardScale*calibration.ronYield
}
