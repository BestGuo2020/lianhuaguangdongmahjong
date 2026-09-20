import type { Meld, TileType } from '../../../core/contracts/types'
import { TILE_TYPES } from '../../../core/rules/tiles'
import { evaluateWin } from '../patterns/evaluate'
import type { WinSource } from './types'

// Cache the canonical scorer, including illegal external joker wins (zero).
// No wall order, opponents' hands, training labels or random seed is accepted.
const scoreCache = new Map<string, number>()
export function forecastWinIncome(
  concealed: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[],
  winningTile: TileType, source: WinSource,
) {
  // Self-draw scoring/catalog never uses the winning instance: all concealed
  // triplets remain concealed. External wins MUST retain that instance (joker
  // legality and concealed-triplet scoring depend on it).
  const self = source === 'self-draw' || source === 'kong-bloom'
  const key = JSON.stringify([self ? [...concealed, winningTile].sort() : [...concealed].sort(),
    melds, [...jokers].sort(), self ? null : winningTile, source])
  const cached = scoreCache.get(key)
  if (cached !== undefined) return cached
  const score = evaluateWin({ concealed, melds, jokers, winningTile, source, opening: null })?.score
  const value = (score?.paymentPerPayer ?? 0) * (source === 'self-draw' || source === 'kong-bloom' ? 3 : 1)
  if (scoreCache.size >= 20_000) scoreCache.delete(scoreCache.keys().next().value!)
  scoreCache.set(key, value)
  return value
}

/** Diagnostic cold-cache measurements must not inherit earlier audit warming. */
export function clearForecastCache() { scoreCache.clear() }

export function unseenCounts(visible: readonly TileType[]) {
  return TILE_TYPES.map(tile => ({ tile, count: Math.max(0, 4 - visible.filter(t => t === tile).length) }))
}

/** Normal rotation only: no speculative claims/kongs. Offset 4 after our turn;
 * offset 1..3 after another seat's discard. Horizon counts our future draws. */
export function ownDrawOpportunities(wall: number, horizon: number, offset = 4) {
  if (wall < offset || horizon <= 0) return 0
  return Math.min(Math.floor(horizon), 1 + Math.floor((wall - offset) / 4))
}

export interface OpportunityCalibration {
  drawScale: number
  discardScale: number
  selfYield: number
  ronYield: number
}

/** Stop before the (horizon+1)th own draw, matching observation collection.
 * Effective multipliers are fitted on training games: meld skips/replacement
 * draws alter draw counts, claims/wins alter discard counts. They are population
 * estimates, not forecasts of a specific opponent's next action. */
export function normalOpportunities(wall: number, horizon: number, offset = 4) {
  if(wall<=0||horizon<=0)return {own:0,opponent:0}
  const own = ownDrawOpportunities(wall,horizon,offset)
  const consumed = Math.max(0,Math.min(wall,offset+4*Math.floor(horizon)-1))
  return {own, opponent:Math.max(0,consumed-own)}
}

export function forecastSourceComponents(
  concealed: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[],
  visible: readonly TileType[], wall: number, horizon: number, offset = 4,
) {
  const counts=unseenCounts(visible), unseen=counts.reduce((n,e)=>n+e.count,0)
  const opportunities=normalOpportunities(wall,horizon,offset)
  let selfPerDraw=0,ronPerDiscard=0
  if(!opportunities.own&&!opportunities.opponent)return {...opportunities,selfPerDraw,ronPerDiscard}
  if(unseen)for(const {tile,count} of counts)if(count) {
    selfPerDraw+=count/unseen*forecastWinIncome(concealed,melds,jokers,tile,'self-draw')
    ronPerDiscard+=count/unseen*forecastWinIncome(concealed,melds,jokers,tile,'discard')
  }
  return {...opportunities,selfPerDraw,ronPerDiscard}
}

export function forecastCalibratedIncome(
  concealed: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[],
  visible: readonly TileType[], wall: number, horizon: number, offset: number,
  calibration: OpportunityCalibration,
) {
  const c=forecastSourceComponents(concealed,melds,jokers,visible,wall,horizon,offset)
  const own=Math.min(horizon,wall,c.own*calibration.drawScale)
  const discards=c.opponent*calibration.discardScale
  return own*c.selfPerDraw*calibration.selfYield + discards*c.ronPerDiscard*calibration.ronYield
}

/** Expected GROSS SELF-DRAW income, fixed hand and normal rotation, exchangeable
 * unseen tiles. Opponent-held tiles stay in the denominator: unseen != wall.
 * Linearity gives n * sum(count/U * income), also for sampling without replacement.
 * Excludes ron, kong payments/replacements, claim skips and future hand changes;
 * therefore this is a component model, NOT a calibrated total or a lower bound. */
export function forecastSelfDrawIncome(
  concealed: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[],
  visible: readonly TileType[], wall: number, horizon: number, offset = 4,
) {
  const draws = ownDrawOpportunities(wall, horizon, offset)
  if (!draws) return 0
  const counts = unseenCounts(visible), unseen = counts.reduce((n, entry) => n + entry.count, 0)
  if (!unseen) return 0
  return Math.min(draws, unseen) * counts.reduce((sum, { tile, count }) =>
    sum + (count ? count / unseen * forecastWinIncome(concealed, melds, jokers, tile, 'self-draw') : 0), 0)
}
