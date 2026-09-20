import type { TileType } from '../src/game/core/contracts/types'
import type { BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { visibleTiles } from '../src/game/variants/lotus/bloodFlow/seatView'
import { forecastWinIncome, unseenCounts } from '../src/game/variants/lotus/bloodFlow/incomeForecast'

export type TileCategory = 'wildcard-face' | 'honor' | 'terminal' | 'middle'
export function tileCategory(tile:TileType,jokers:readonly TileType[]):TileCategory {
  if(tile==='white'||jokers.includes(tile))return 'wildcard-face'
  if(!/^[mps][1-9]$/.test(tile))return 'honor'
  return tile.endsWith('1')||tile.endsWith('9')?'terminal':'middle'
}
export function ronFeatures(view:BloodFlowSeatView,ronYield:number) {
  const p=view.players[view.seat],counts=unseenCounts(visibleTiles(view))
  const buckets:Record<TileCategory,{mass:number;income:number}>= {
    'wildcard-face':{mass:0,income:0},honor:{mass:0,income:0},terminal:{mass:0,income:0},middle:{mass:0,income:0},
  }
  let mass=0,winningMass=0,income=0
  for(const {tile,count} of counts)if(count){
    const value=forecastWinIncome(p.hand,p.melds,view.jokers,tile,'discard'),bucket=buckets[tileCategory(tile,view.jokers)]
    mass+=count;bucket.mass+=count;bucket.income+=count*value;income+=count*value
    if(value)winningMass+=count
  }
  const waitValue=winningMass?income/winningMass:0
  return {buckets,mass,waitValue,winningMass,
    valueBand:!winningMass?'no-live-ron':waitValue<=40?'low-1-40':waitValue<=160?'mid-40-160':'high-over-160',
    predicted:mass?income/mass*ronYield:0}
}
