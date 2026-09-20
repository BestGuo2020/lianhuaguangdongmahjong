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
  const key = JSON.stringify([[...concealed].sort(), melds, [...jokers].sort(), winningTile, source])
  const cached = scoreCache.get(key)
  if (cached !== undefined) return cached
  const score = evaluateWin({ concealed, melds, jokers, winningTile, source, opening: null })?.score
  const value = (score?.paymentPerPayer ?? 0) * (source === 'self-draw' || source === 'kong-bloom' ? 3 : 1)
  if (scoreCache.size >= 20_000) scoreCache.delete(scoreCache.keys().next().value!)
  scoreCache.set(key, value)
  return value
}

export function unseenCounts(visible: readonly TileType[]) {
  return TILE_TYPES.map(tile => ({ tile, count: Math.max(0, 4 - visible.filter(t => t === tile).length) }))
}

/** Normal rotation only: no speculative claims/kongs. Offset 4 after our turn;
 * offset 1..3 after another seat's discard. Horizon counts our future draws. */
export function ownDrawOpportunities(wall: number, horizon: number, offset = 4) {
  if (wall < offset || horizon <= 0) return 0
  return Math.min(Math.floor(horizon), 1 + Math.floor((wall - offset) / 4))
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
