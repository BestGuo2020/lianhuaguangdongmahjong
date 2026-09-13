import type { TileType } from '../../../core/contracts/types'
import type { DecomposedGroup, PatternId, WinningDecomposition } from './types'

export const WINDS: readonly TileType[] = ['east', 'south', 'west', 'north']
export const DRAGONS: readonly TileType[] = ['red', 'green', 'white']
export const isHonor = (tile: TileType) => tile.length !== 2
export const isTerminal = (tile: TileType) => tile.length === 2 && (tile[1] === '1' || tile[1] === '9')

/** 一组数字里是否存在 length 个连续整数（用于一色三步高/四步高、节高系列）。 */
function hasConsecutiveRun(numbers: readonly number[], length: number): boolean {
  const unique = [...new Set(numbers.filter(n => Number.isFinite(n)))].sort((a, b) => a - b)
  let streak = unique.length ? 1 : 0
  for (let index = 1; index < unique.length; index += 1) {
    streak = unique[index] === unique[index - 1] + 1 ? streak + 1 : 1
    if (streak >= length) return true
  }
  return streak >= length
}

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
  const sequences = melds.filter(g => g.kind === 'sequence')
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
  // —— 2026-09-12 第二版番种表新增 ——
  // 门清：**仅标准四面子一将型生效**（七对/十三幺/十三烂/七星等特殊结构在上面已提前返回，天然不计门清）：
  // 全部面子都出自手牌（暗杠不破门清；吃/碰/明杠会破）。
  if (hand.groups.every(g => g.origin.kind === 'hand')) result.push('concealed-hand')
  // 断幺九：全部为 2~8 数牌。
  if (tiles.every(t => !isHonor(t) && !isTerminal(t))) result.push('all-simples')
  // 全带幺：每副面子与将牌都含幺九或字牌（允许 123 / 789 这类含幺的顺子）。
  if (hand.groups.every(g => g.tiles.some(t => isHonor(t) || isTerminal(t)))) result.push('all-with-terminals')
  // 一色步高 / 清龙：同花色顺子的起始数字关系。
  const bySuit = (groups: readonly DecomposedGroup[]) => {
    const map = new Map<string, number[]>()
    for (const group of groups) {
      const tile = group.tiles[0]
      if (isHonor(tile)) continue
      map.set(tile[0], [...(map.get(tile[0]) ?? []), Number(tile[1])])
    }
    return map
  }
  for (const starts of bySuit(sequences).values()) {
    if (hasConsecutiveRun(starts, 4)) result.push('one-suit-four-steps')
    else if (hasConsecutiveRun(starts, 3)) result.push('one-suit-three-steps')
    if ([1, 4, 7].every(start => starts.includes(start))) result.push('pure-straight')
  }
  // 一色节高：同花色刻子/杠的数字连续。
  for (const numbers of bySuit(triplets).values()) {
    if (hasConsecutiveRun(numbers, 4)) result.push('one-suit-four-joints')
    else if (hasConsecutiveRun(numbers, 3)) result.push('one-suit-three-joints')
  }
  return result.length ? result : ['pinghu']
}
