import type { TileType } from '../../../core/contracts/types'
import type { PatternId, WinningDecomposition } from './types'

export const WINDS: readonly TileType[] = ['east', 'south', 'west', 'north']
export const DRAGONS: readonly TileType[] = ['red', 'green', 'white']
export const isHonor = (tile: TileType) => tile.length !== 2
export const isTerminal = (tile: TileType) => tile.length === 2 && (tile[1] === '1' || tile[1] === '9')

export function matchPatterns(hand: WinningDecomposition): PatternId[] {
  if (hand.shape !== 'standard' && hand.shape !== 'sevenPairs') return [hand.shape]
  const result: PatternId[] = hand.shape === 'sevenPairs' ? ['sevenPairs'] : []
  const tiles = hand.groups.flatMap(g => [...g.tiles])
  const suits = new Set(tiles.filter(t => !isHonor(t)).map(t => t[0]))
  const honors = tiles.some(isHonor)
  // 豪华七对：七对里含自然四张相同（`natural` 表示每张实体牌都按本张使用，所以四张同牌即自然四张）。
  if (hand.shape === 'sevenPairs' && hand.natural
    && tiles.some(tile => tiles.filter(other => other === tile).length >= 4)) result.push('luxury-seven-pairs')
  if (suits.size === 1) result.push(honors ? 'mixed-suit' : 'pure-suit')
  if (tiles.every(isHonor)) result.push('all-honors')
  if (tiles.every(t => ['s2', 's3', 's4', 's6', 's8', 'green'].includes(t))) result.push('all-green')
  if (hand.shape === 'sevenPairs') return result
  const melds = hand.groups.filter(g => g.kind !== 'pair')
  const pair = hand.groups.find(g => g.kind === 'pair')!.tiles[0]
  const triplets = melds.filter(g => g.kind === 'triplet' || g.kind === 'kong')
  const allTriplets = triplets.length === 4
  if (allTriplets) result.push('all-triplets')
  const dragonCount = DRAGONS.filter(t => triplets.some(g => g.tiles[0] === t)).length
  const windCount = WINDS.filter(t => triplets.some(g => g.tiles[0] === t)).length
  if (dragonCount === 3) result.push('big-three-dragons')
  if (dragonCount === 2 && DRAGONS.includes(pair) && !triplets.some(g => g.tiles[0] === pair)) result.push('little-three-dragons')
  if (windCount === 4) result.push('big-four-winds')
  if (windCount === 3 && WINDS.includes(pair) && !triplets.some(g => g.tiles[0] === pair)) result.push('little-four-winds')
  if (allTriplets && tiles.every(isTerminal)) result.push('pure-terminals')
  if (allTriplets && honors && suits.size > 0 && tiles.every(t => isHonor(t) || isTerminal(t))) result.push('mixed-terminals')
  const concealed = triplets.filter(g => g.concealed).length
  if (concealed >= 3) result.push('three-concealed-triplets')
  if (concealed === 4) result.push('four-concealed-triplets')
  const kongs = melds.filter(g => g.kind === 'kong').length
  if (kongs >= 3) result.push('three-kongs')
  if (kongs === 4) result.push('four-kongs')
  if (suits.size === 1 && !honors && hand.groups.every(g => g.origin.kind === 'hand')) {
    const counts = Array.from({ length: 9 }, (_, n) => tiles.filter(t => Number(t[1]) === n + 1).length)
    if (counts.every((n, i) => n >= (i === 0 || i === 8 ? 3 : 1))) result.push('nine-gates')
  }
  return result.length ? result : ['pinghu']
}
