import type { TileType } from '../../core/contracts/types'
import { TILE_TYPES } from '../../core/rules/tiles'

export interface HandProgressOptions {
  exposedMelds: number
  wildcardTiles?: readonly TileType[]
  visibleTiles?: readonly TileType[]
  waitingTiles: (hand: TileType[], exposedMelds: number) => TileType[]
  /** 门清玩法额外支持的特殊牌型；莲花麻将启用。 */
  specialHands?: boolean
}

export interface HandProgress {
  /** 0=听牌，1=一向听；数值越小越接近胡牌。 */
  shanten: number
  waits: TileType[]
  effectiveTiles: Array<{ tile: TileType; remaining: number }>
  /** 所有能降低向听牌张的实际剩余总数。 */
  ukeire: number
  /** 已听牌时的实际剩余听牌张数。 */
  effectiveRemaining: number
}

const tileIndex = new Map(TILE_TYPES.map((tile, index) => [tile, index]))
const standardCache = new Map<string, number>()
const jokerAllocationCache = new Map<string, number>()

function completionShanten(melds: number, pairs: number, taatsu: number, jokers: number): number {
  if (melds > 4) return 8
  const key = `${melds}|${pairs}|${taatsu}|${jokers}`
  const cached = jokerAllocationCache.get(key)
  if (cached !== undefined) return cached
  if (jokers === 0) {
    const result = 8 - melds * 2 - Math.min(taatsu, 4 - melds) - Math.min(1, pairs)
    jokerAllocationCache.set(key, result)
    return result
  }
  let best = completionShanten(melds, pairs, taatsu, jokers - 1)
  if (pairs === 0 && jokers >= 2) best = Math.min(best, completionShanten(melds, 1, taatsu, jokers - 2))
  if (jokers >= 2) best = Math.min(best, completionShanten(melds, pairs, taatsu + 1, jokers - 2))
  if (jokers >= 3) best = Math.min(best, completionShanten(melds + 1, pairs, taatsu, jokers - 3))
  jokerAllocationCache.set(key, best)
  return best
}

function countTiles(tiles: readonly TileType[]) {
  const counts = Array<number>(TILE_TYPES.length).fill(0)
  for (const tile of tiles) counts[tileIndex.get(tile) ?? 0] += 1
  return counts
}

function remaining(tile: TileType, visibleTiles: readonly TileType[]) {
  let seen = 0
  for (const visible of visibleTiles) if (visible === tile) seen += 1
  return Math.max(0, 4 - seen)
}

/**
 * 标准 4 面子 + 1 将向听。DFS 同时枚举刻子、顺子、对子和搭子；
 * 万能牌按缺张补入，因此白板癞子和翻精都能参与结构计算。
 */
export function standardShanten(
  hand: readonly TileType[],
  exposedMelds = 0,
  wildcardTiles: readonly TileType[] = [],
): number {
  const wildcards = new Set(wildcardTiles)
  const natural = hand.filter((tile) => !wildcards.has(tile))
  const jokerCount = hand.length - natural.length
  const cacheKey = `${exposedMelds}|${[...wildcards].sort().join(',')}|${[...hand].sort().join(',')}`
  const cached = standardCache.get(cacheKey)
  if (cached !== undefined) return cached
  const counts = countTiles(natural)
  let best = 8
  const memo = new Set<string>()

  function finish(melds: number, pairs: number, taatsu: number, jokers: number) {
    best = Math.min(best, completionShanten(melds, pairs, taatsu, jokers))
  }

  function dfs(start: number, melds: number, pairs: number, taatsu: number, jokers: number) {
    while (start < counts.length && counts[start] === 0) start += 1
    if (start >= counts.length) {
      finish(melds + exposedMelds, pairs, taatsu, jokers)
      return
    }
    const signature = `${counts.join('')}|${start}|${melds}|${pairs}|${taatsu}|${jokers}`
    if (memo.has(signature)) return
    memo.add(signature)

    // 丢弃一张孤张。
    counts[start] -= 1
    dfs(start, melds, pairs, taatsu, jokers)
    counts[start] += 1

    // 刻子（允许万能牌补缺）。
    const tripletReal = Math.min(3, counts[start])
    const tripletMissing = 3 - tripletReal
    if (tripletMissing <= jokers) {
      counts[start] -= tripletReal
      dfs(start, melds + 1, pairs, taatsu, jokers - tripletMissing)
      counts[start] += tripletReal
    }

    // 对子/对子搭子。
    const pairReal = Math.min(2, counts[start])
    const pairMissing = 2 - pairReal
    if (pairMissing <= jokers) {
      counts[start] -= pairReal
      if (pairs === 0) dfs(start, melds, 1, taatsu, jokers - pairMissing)
      dfs(start, melds, pairs, taatsu + 1, jokers - pairMissing)
      counts[start] += pairReal
    }

    const suited = start < 27
    const rank = start % 9
    if (!suited) return

    // 顺子。
    for (let sequenceStart = Math.max(start - Math.min(2, rank), start - rank); sequenceStart <= Math.min(start, start - rank + 6); sequenceStart += 1) {
      const sequence = [sequenceStart, sequenceStart + 1, sequenceStart + 2]
      const consumed = sequence.map((index) => counts[index] > 0)
      const missing = consumed.filter((value) => !value).length
      if (missing <= jokers) {
        sequence.forEach((index, position) => { if (consumed[position]) counts[index] -= 1 })
        dfs(start, melds + 1, pairs, taatsu, jokers - missing)
        sequence.forEach((index, position) => { if (consumed[position]) counts[index] += 1 })
      }
    }

    // 两面/嵌张搭子；缺一张时可由万能牌补成现有搭子。
    for (const gap of [1, 2]) {
      const other = start + gap
      if (other >= 27 || Math.floor(other / 9) !== Math.floor(start / 9)) continue
      const usedStart = counts[start] > 0
      const usedOther = counts[other] > 0
      const missing = Number(!usedStart) + Number(!usedOther)
      if (missing > jokers) continue
      if (usedStart) counts[start] -= 1
      if (usedOther) counts[other] -= 1
      dfs(start, melds, pairs, taatsu + 1, jokers - missing)
      if (usedStart) counts[start] += 1
      if (usedOther) counts[other] += 1
    }
  }

  dfs(0, 0, 0, 0, jokerCount)
  const result = Math.max(-1, best)
  if (standardCache.size >= 100_000) standardCache.delete(standardCache.keys().next().value!)
  standardCache.set(cacheKey, result)
  return result
}

const ORPHANS = new Set<TileType>([
  'm1', 'm9', 'p1', 'p9', 's1', 's9',
  'east', 'south', 'west', 'north', 'red', 'green', 'white',
])

function sevenPairsShanten(hand: readonly TileType[], wildcardTiles: ReadonlySet<TileType>) {
  const counts = new Map<TileType, number>()
  let jokers = 0
  hand.forEach((tile) => wildcardTiles.has(tile) ? jokers += 1 : counts.set(tile, (counts.get(tile) ?? 0) + 1))
  let pairs = 0
  let singles = 0
  counts.forEach((count) => { pairs += Math.floor(count / 2); singles += count % 2 })
  const jokerPairs = Math.min(singles, jokers)
  pairs += jokerPairs
  jokers -= jokerPairs
  pairs += Math.floor(jokers / 2)
  return Math.max(0, 6 - pairs + Math.max(0, 7 - counts.size - Math.ceil(jokers / 2)))
}

function thirteenOrphansShanten(hand: readonly TileType[], wildcardTiles: ReadonlySet<TileType>) {
  const natural = hand.filter((tile) => !wildcardTiles.has(tile))
  const jokers = hand.length - natural.length
  const unique = new Set(natural.filter((tile) => ORPHANS.has(tile))).size
  const hasPair = [...ORPHANS].some((tile) => natural.filter((item) => item === tile).length >= 2)
  const missing = Math.max(0, 13 - unique - jokers)
  const spareJoker = Math.max(0, jokers - (13 - unique))
  return Math.max(0, missing + (hasPair || spareJoker > 0 ? 0 : 1))
}

function spacedSuitCount(ranks: number[]) {
  const unique = [...new Set(ranks)].sort((a, b) => a - b)
  const dp = unique.map(() => 1)
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = 0; j < i; j += 1) if (unique[i] - unique[j] >= 3) dp[i] = Math.max(dp[i], dp[j] + 1)
  }
  return dp.length ? Math.max(...dp) : 0
}

function shiSanLanShanten(hand: readonly TileType[], wildcardTiles: ReadonlySet<TileType>) {
  const natural = hand.filter((tile) => !wildcardTiles.has(tile))
  const jokers = hand.length - natural.length
  const honors = new Set(natural.filter((tile) => !/^[mps][1-9]$/.test(tile))).size
  const suited = ['m', 'p', 's'].reduce((sum, suit) => sum + spacedSuitCount(
    natural.filter((tile) => tile[0] === suit).map((tile) => Number(tile[1])),
  ), 0)
  return Math.max(0, 13 - Math.min(13, honors + suited + jokers))
}

function shantenOf(hand: readonly TileType[], options: HandProgressOptions) {
  const wildcardSet = new Set(options.wildcardTiles ?? [])
  const standard = standardShanten(hand, options.exposedMelds, [...wildcardSet])
  if (!options.specialHands || options.exposedMelds > 0) return standard
  return Math.min(
    standard,
    sevenPairsShanten(hand, wildcardSet),
    thirteenOrphansShanten(hand, wildcardSet),
    shiSanLanShanten(hand, wildcardSet),
  )
}

export function evaluateHandProgress(hand: TileType[], options: HandProgressOptions): HandProgress {
  const visible = options.visibleTiles ?? hand
  const waits = options.waitingTiles(hand, options.exposedMelds)
  const rawShanten = waits.length ? 0 : Math.max(1, shantenOf(hand, options))
  const effectiveRemaining = waits.reduce((sum, tile) => sum + remaining(tile, visible), 0)
  if (waits.length) {
    const effectiveTiles = waits.map((tile) => ({ tile, remaining: remaining(tile, visible) }))
    return { shanten: 0, waits, effectiveTiles, ukeire: effectiveRemaining, effectiveRemaining }
  }

  // 三向听及更远的完整 34 面枚举对早巡批量对局代价过高，且误差对舍牌影响小；
  // 仍保留精确向听，进入二向听后再计算完整有效进张。
  if (rawShanten > 2) {
    return { shanten: rawShanten, waits, effectiveTiles: [], ukeire: 0, effectiveRemaining }
  }

  const effectiveTiles: Array<{ tile: TileType; remaining: number }> = []
  for (const tile of TILE_TYPES) {
    const tileRemaining = remaining(tile, visible)
    if (tileRemaining <= 0) continue
    // shantenOf 的 DFS 本身允许跳过孤张，因此可直接评价摸牌后的 3n+2 手牌；
    // 等价于枚举“摸入后最佳弃一张”，但避免额外的 14 倍分支。
    const drawn = [...hand, tile]
    const nextBest = shantenOf(drawn, options)
    if (nextBest < rawShanten) effectiveTiles.push({ tile, remaining: tileRemaining })
  }
  return {
    shanten: rawShanten,
    waits,
    effectiveTiles,
    ukeire: effectiveTiles.reduce((sum, item) => sum + item.remaining, 0),
    effectiveRemaining,
  }
}

export function compareHandProgress(a: HandProgress, b: HandProgress) {
  if (a.shanten !== b.shanten) return b.shanten - a.shanten
  if (a.ukeire !== b.ukeire) return a.ukeire - b.ukeire
  if (a.effectiveRemaining !== b.effectiveRemaining) return a.effectiveRemaining - b.effectiveRemaining
  return a.waits.length - b.waits.length
}
