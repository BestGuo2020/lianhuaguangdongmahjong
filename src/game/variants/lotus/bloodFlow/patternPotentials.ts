// 血流本地 AI 的番型潜力与收益估算（纯函数，只读不改状态）。
// 这些是决策用的估算器：完整 14 张才用于收益估算，且只服务排序与期望，
// 实际结算仍由引擎的 evaluateWin 精确计算。经典玩法不 import 本模块。
import type { Meld, TileType } from '../../../core/contracts/types'
import { HONORS, TILE_TYPES } from '../../../core/rules/tiles'
import type { PatternId } from '../patterns/types'
import { waitingTiles } from '../lotusRules'
import type { WinSource } from './types'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG } from './config'

export function wildcardSet(jokers: readonly TileType[]) {
  return new Set<TileType>([...jokers, 'white'])
}

// ── 特殊手潜力（与经典 lotusAi 同口径，移入本模块共用） ──

const THIRTEEN_ORPHAN_TERMINALS: TileType[] = [
  'm1', 'm9', 'p1', 'p9', 's1', 's9',
  'east', 'south', 'west', 'north', 'red', 'green', 'white',
]

/** 十三烂/七星十三烂潜力：缺陷越少、字牌越齐、精牌越多越接近。 */
export function shiSanLanPotential(hand: readonly TileType[], jokers: readonly TileType[]) {
  const jokerSet = new Set(jokers)
  const natural = hand.filter((tile) => !jokerSet.has(tile))
  let defects = natural.length - new Set(natural).size
  for (const suit of ['m', 'p', 's']) {
    const ranks = natural
      .filter((tile) => tile.length === 2 && tile[0] === suit)
      .map((tile) => Number(tile[1]))
      .sort((a, b) => a - b)
    for (let index = 1; index < ranks.length; index += 1) {
      if (ranks[index] - ranks[index - 1] < 3) defects += 1
    }
  }
  const honorsHeld = HONORS.filter((honor) => natural.includes(honor)).length
  const jokerCount = hand.length - natural.length
  const honorShortfall = Math.max(0, 7 - honorsHeld)
  const jokersAfterHonors = Math.max(0, jokerCount - honorShortfall)
  const defectsAfterJokers = Math.max(0, defects - jokersAfterHonors)
  if (defectsAfterJokers > 3) return 0
  return (4 - defectsAfterJokers) * 4 + honorsHeld + jokerCount
}

/** 十三幺潜力：13 种幺九/字牌持有进度 + 精牌可替补 + 对子可成。 */
export function thirteenOrphansPotential(hand: readonly TileType[], jokers: readonly TileType[]) {
  const jokerSet = new Set(jokers)
  const natural = hand.filter((tile) => !jokerSet.has(tile))
  const heldKinds = THIRTEEN_ORPHAN_TERMINALS.filter((tile) => natural.includes(tile)).length
  const jokerCount = hand.length - natural.length
  const kindsAfterJokers = heldKinds + jokerCount
  if (kindsAfterJokers < 10) return 0
  const hasPair = THIRTEEN_ORPHAN_TERMINALS.some((tile) => matchingCount(natural, tile) >= 2)
  const pairScore = hasPair || jokerCount >= 2 ? 8 : 0
  return (kindsAfterJokers - 10) * 3 + pairScore
}

/** 七对子潜力：已有对子数 + 精牌可补单张成对。 */
export function sevenPairsPotential(hand: readonly TileType[], jokers: readonly TileType[]) {
  const jokerSet = new Set(jokers)
  const counts = new Map<TileType, number>()
  let jokerCount = 0
  hand.forEach((tile) => {
    if (jokerSet.has(tile)) jokerCount += 1
    else counts.set(tile, (counts.get(tile) ?? 0) + 1)
  })
  let pairs = 0
  let singles = 0
  counts.forEach((count) => {
    pairs += Math.floor(count / 2)
    singles += count % 2
  })
  const nearSeven = pairs + Math.min(singles, jokerCount)
  if (nearSeven < 5) return 0
  return nearSeven * 4
}

// ── 计数与结构工具 ──

function matchingCount(tiles: readonly TileType[], tile: TileType) {
  let count = 0
  for (const item of tiles) if (item === tile) count += 1
  return count
}

function countMap(tiles: readonly TileType[]) {
  const counts = new Map<TileType, number>()
  tiles.forEach((tile) => { counts.set(tile, (counts.get(tile) ?? 0) + 1) })
  return counts
}

/** 同牌刻副露（碰 / 直杠 / 补杠 / 暗杠）；风杠按规则不算同牌刻。 */
function tripletMelds(melds: readonly Readonly<Meld>[]) {
  return melds.filter(m => m.type !== 'chi' && !m.windKong)
}

/** 已成功声明的普通四张杠（三杠/四杠只数它，风杠不算）。 */
function declaredGangCount(melds: readonly Readonly<Meld>[]) {
  return melds.filter(m => (m.type === 'gang' || m.type === 'angang') && !m.windKong).length
}

function isSuited(tile: TileType) { return tile.length === 2 }
function isHonor(tile: TileType) { return !isSuited(tile) }
function suitOf(tile: TileType) { return tile[0] as 'm' | 'p' | 's' }
function rankOf(tile: TileType) { return Number(tile[1]) }

const GREEN_TILES = new Set<TileType>(['s2', 's3', 's4', 's6', 's8', 'green'])
const TERMINAL_TILES = new Set<TileType>(['m1', 'm9', 'p1', 'p9', 's1', 's9'])
const DRAGONS: readonly TileType[] = ['red', 'green', 'white']
const WINDS: readonly TileType[] = ['east', 'south', 'west', 'north']

interface HandShape {
  natural: TileType[]
  counts: Map<TileType, number>
  jokerCount: number
  suited: TileType[]
  honors: TileType[]
}

function shape(hand: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[]) {
  const wild = wildcardSet(jokers)
  const natural = hand.filter(tile => !wild.has(tile))
  return {
    natural, counts: countMap(natural), jokerCount: hand.length - natural.length,
    suited: natural.filter(isSuited), honors: natural.filter(isHonor),
    meldTiles: melds.flatMap(m => m.tiles),
  }
}

// ── 方向潜力 ──

export interface PatternDirection {
  id: PatternId
  weight: number
  /** 0..1 接近度估计。 */
  progress: number
  /** weight × progress²，潜力分口径。 */
  score: number
}

/** 每种方向给定结构下的接近度；纯估算，供排序与门槛比较。 */
export function patternPotentials(hand: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[]): PatternDirection[] {
  const s = shape(hand, melds, jokers)
  const effective = hand.length + 3 * melds.length
  const directions: PatternDirection[] = []
  const add = (id: PatternId, progress: number) => {
    const weight = BLOOD_FLOW_CONFIG.patterns[id].weight
    if (progress > 0) directions.push({ id, weight, progress: Math.min(1, progress), score: weight * Math.min(1, progress) ** 2 })
  }
  const meldTiles = s.meldTiles
  const allNatural = [...s.natural, ...meldTiles]

  // 清一色 / 混一色：数牌须同色；清一色不允许字牌与异色副露。
  const suitCounts = new Map<'m' | 'p' | 's', number>()
  s.suited.forEach(tile => suitCounts.set(suitOf(tile), (suitCounts.get(suitOf(tile)) ?? 0) + 1))
  const meldHonors = meldTiles.filter(isHonor).length
  const meldSuits = new Set(meldTiles.filter(isSuited).map(suitOf))
  const mainSuit = [...suitCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const mainCount = mainSuit ? suitCounts.get(mainSuit)! : 0
  const singleSuitMelds = meldSuits.size <= 1 && (mainSuit === undefined || meldSuits.size === 0 || meldSuits.has(mainSuit))
  if (s.honors.length === 0 && meldHonors === 0 && singleSuitMelds && (mainCount + s.jokerCount) > 0) {
    add('pure-suit', (mainCount + s.jokerCount) / effective)
  }
  const honorsOrJoker = s.honors.length + meldHonors + s.jokerCount
  if (singleSuitMelds && (mainCount + s.jokerCount) > 0 && honorsOrJoker > 0
    && (s.honors.length + meldHonors > 0 || s.jokerCount > 0)) {
    add('mixed-suit', (mainCount + s.jokerCount + s.honors.length + meldHonors) / effective)
  }

  // 碰碰胡：无数牌顺与字牌顺；对/刻 + 精牌向 4 刻 + 1 将靠近。
  const hasChiMeld = melds.some(m => m.type === 'chi')
  if (!hasChiMeld) {
    let tripletUnits = tripletMelds(melds).length
    s.counts.forEach((count) => { tripletUnits += Math.floor(count / 3) + (count % 3 === 2 ? 1 : 0) })
    add('all-triplets', (tripletUnits + s.jokerCount) / 5)
  }

  // 大小三元 / 四喜：箭风刻 + 将。
  for (const [id, set, need, pairNeed] of [
    ['little-three-dragons', DRAGONS, 2, 1], ['big-three-dragons', DRAGONS, 3, 0],
    ['little-four-winds', WINDS, 3, 1], ['big-four-winds', WINDS, 4, 0],
  ] as const) {
    let units = 0, pairs = 0
    for (const tile of set) {
      const count = s.counts.get(tile) ?? 0
      units += count >= 3 ? 1 : tripletMelds(melds).some(m => m.tile === tile) ? 1 : 0
      if (count === 2) pairs += 1
    }
    const jokers = s.jokerCount
    const withJokers = Math.min(need, units + Math.max(0, jokers - pairNeed))
    add(id as PatternId, (withJokers + Math.min(pairNeed, pairs + Math.min(jokers, pairNeed))) / (need + pairNeed))
  }

  // 九莲宝灯：无副露，同花色 1112345678999 + 任意同色一张。
  if (melds.length === 0 && s.honors.length === 0 && suitCounts.size <= 1) {
    const need = [3, 1, 1, 1, 1, 1, 1, 1, 3]
    let satisfied = 0
    for (let rank = 1; rank <= 9; rank += 1) {
      const count = s.counts.get(`${mainSuit ?? 'm'}${rank}` as TileType) ?? 0
      satisfied += Math.min(count, need[rank - 1])
    }
    const jokers = s.jokerCount
    add('nine-gates', Math.min(1, (satisfied + jokers) / 14) * (suitCounts.size <= 1 ? 1 : 0))
  }

  // 绿一色：仅二三四六八条与发。
  if (melds.every(m => m.tiles.every(t => GREEN_TILES.has(t) || wildcardSet(jokers).has(t)))) {
    const inSet = s.natural.filter(t => GREEN_TILES.has(t)).length
    add('all-green', (inSet + s.jokerCount) / effective)
  }

  // 清幺九 / 混幺九：幺九与字牌刻。
  if (!hasChiMeld) {
    const restricted = allNatural.every(t => TERMINAL_TILES.has(t) || isHonor(t))
    if (restricted && s.honors.length + meldHonors === 0) {
      let units = tripletMelds(melds).length
      s.counts.forEach((count) => { units += Math.floor(count / 3) })
      add('pure-terminals', (units + s.jokerCount) / 5)
    }
    if (restricted && (s.suited.length > 0 || s.jokerCount > 0) && (s.honors.length + meldHonors > 0 || s.jokerCount > 0)) {
      let units = tripletMelds(melds).length
      s.counts.forEach((count) => { units += Math.floor(count / 3) })
      add('mixed-terminals', (units + s.jokerCount) / 5)
    }
  }

  // 三 / 四暗刻：暗刻 + 暗杠。
  {
    let concealedUnits = melds.filter(m => m.type === 'angang').length
    s.counts.forEach((count) => { if (count >= 3) concealedUnits += 1 })
    add('three-concealed-triplets', (concealedUnits + s.jokerCount) / 3)
    add('four-concealed-triplets', (concealedUnits + s.jokerCount) / 4)
  }

  // 字一色：全部字牌（允许字顺与风杠）。
  if (s.suited.length === 0 && meldTiles.every(isHonor)) {
    add('all-honors', (s.honors.length + s.jokerCount) / effective)
  }

  // 三 / 四杠：已声明普通杠。
  {
    const gangs = declaredGangCount(melds)
    if (gangs > 0) {
      add('three-kongs', gangs / 3)
      add('four-kongs', gangs / 4)
    }
  }

  // 特殊手（复用与经典 AI 同口径的潜力函数）。
  const wild = [...wildcardSet(jokers)]
  const shiSan = shiSanLanPotential(hand, wild)
  if (shiSan > 0) {
    const honorsHeld = HONORS.filter(h => s.natural.includes(h)).length
    add('shiSanLan', Math.min(1, shiSan / 24))
    if (honorsHeld === 7 && s.jokerCount === 0) add('qiXing', Math.min(1, shiSan / 24))
  }
  const orphans = thirteenOrphansPotential(hand, wild)
  if (orphans > 0) add('thirteenOrphans', Math.min(1, orphans / 17))
  const seven = sevenPairsPotential(hand, wild)
  if (seven > 0) add('sevenPairs', Math.min(1, seven / 28))

  return directions
}

/** 潜力总分（potentialFloor 同一口径）。 */
export function patternPotentialTotal(hand: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[]) {
  return patternPotentials(hand, melds, jokers).reduce((total, d) => total + d.score, 0)
}

/** 弃牌排序用的潜力收益（点）：总分 × 底分，残局打折。 */
export function patternPotentialEv(hand: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[], wallCount: number) {
  const late = wallCount <= BLOOD_FLOW_AI.lateGameWallCount ? 0.4 : 1
  return patternPotentialTotal(hand, melds, jokers) * BLOOD_FLOW_CONFIG.basePoints * late
}

// ── 完整 14 张的收益估算（只用于连锁期望与排序，不参与结算） ──

function certainPatterns(hand: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[]): Set<PatternId> {
  const s = shape(hand, melds, jokers)
  const certain = new Set<PatternId>()
  const meldTiles = s.meldTiles
  const suited = s.suited
  const suits = new Set(suited.map(suitOf))
  const honors = s.honors.length + meldTiles.filter(isHonor).length
  const jokerCount = s.jokerCount
  const hasChiMeld = melds.some(m => m.type === 'chi')

  if (honors === 0 && suits.size <= 1 && suited.length + jokerCount > 0) certain.add('pure-suit')
  if (suits.size <= 1 && honors > 0 && suited.length + jokerCount > 0) certain.add('mixed-suit')

  if (!hasChiMeld) {
    // 刻子可行性：c%3==1 需 2 精补刻；另需一对（c%3==2 或 2 精）。
    let jokerDemand = 0
    let pairFound = false
    s.counts.forEach((count) => {
      const rest = count % 3
      if (rest === 1) jokerDemand += 2
      if (rest === 2) pairFound = true
    })
    if (!pairFound) jokerDemand += Math.max(0, 2 - jokerCount)
    if (jokerDemand <= jokerCount) certain.add('all-triplets')
  }

  let concealedUnits = melds.filter(m => m.type === 'angang').length
  s.counts.forEach((count) => { if (count >= 3) concealedUnits += 1 })
  if (concealedUnits >= 3) certain.add('three-concealed-triplets')
  if (concealedUnits >= 4) certain.add('four-concealed-triplets')

  const dragonUnits = DRAGONS.filter(tile => {
    const count = s.counts.get(tile) ?? 0
    return count >= 3 || tripletMelds(melds).some(m => m.tile === tile)
  })
  const dragonPairs = DRAGONS.filter(tile => (s.counts.get(tile) ?? 0) === 2)
  if (dragonUnits.length === 3) certain.add('big-three-dragons')
  else if (dragonUnits.length === 2 && (dragonPairs.length > 0 || jokerCount > 0)) certain.add('little-three-dragons')

  const windUnits = WINDS.filter(tile => {
    const count = s.counts.get(tile) ?? 0
    return count >= 3 || tripletMelds(melds).some(m => m.tile === tile)
  })
  const windPairs = WINDS.filter(tile => (s.counts.get(tile) ?? 0) === 2)
  if (windUnits.length === 4) certain.add('big-four-winds')
  else if (windUnits.length === 3 && (windPairs.length > 0 || jokerCount > 0)) certain.add('little-four-winds')

  if (melds.length === 0 && honors === 0 && suits.size <= 1) {
    const need = [3, 1, 1, 1, 1, 1, 1, 1, 3]
    let deficit = 0
    for (let rank = 1; rank <= 9; rank += 1) {
      const count = s.counts.get(`${[...suits][0] ?? 'm'}${rank}` as TileType) ?? 0
      deficit += Math.max(0, need[rank - 1] - count)
    }
    if (deficit <= jokerCount) certain.add('nine-gates')
  }

  if (allTilesInSet([...hand, ...meldTiles], jokers, GREEN_TILES)) certain.add('all-green')

  const restricted = [...hand, ...meldTiles].every(t => TERMINAL_TILES.has(t) || isHonor(t) || wildcardSet(jokers).has(t))
  if (restricted && honors === 0 && !hasChiMeld) certain.add('pure-terminals')
  if (restricted && honors > 0 && suited.length + jokerCount > 0 && !hasChiMeld) certain.add('mixed-terminals')

  if (suited.length === 0 && meldTiles.every(isHonor)) certain.add('all-honors')

  const gangs = declaredGangCount(melds)
  if (gangs >= 3) certain.add('three-kongs')
  if (gangs >= 4) certain.add('four-kongs')

  const wild = [...wildcardSet(jokers)]
  if (sevenPairsPotential(hand, wild) >= 28) certain.add('sevenPairs')
  const shiSan = shiSanLanPotential(hand, wild)
  const honorsHeld = HONORS.filter(h => s.natural.includes(h)).length
  if (shiSan > 0 && shiSanLanDefectFree(hand, wild)) {
    certain.add(honorsHeld === 7 && jokerCount === 0 ? 'qiXing' : 'shiSanLan')
  }
  const orphans = thirteenOrphansPotential(hand, wild)
  if (orphans >= 17) certain.add('thirteenOrphans')

  // 排除关系（与 config.excludes 同口径）：被包含项不计。
  for (const id of [...certain]) {
    for (const excluded of BLOOD_FLOW_CONFIG.patterns[id].excludes) certain.delete(excluded)
  }
  return certain
}

function allTilesInSet(tiles: readonly TileType[], jokers: readonly TileType[], set: Set<TileType>) {
  const wild = wildcardSet(jokers)
  return tiles.every(t => set.has(t) || wild.has(t))
}

function shiSanLanDefectFree(hand: readonly TileType[], jokers: readonly TileType[]) {
  const jokerSet = new Set(jokers)
  const natural = hand.filter(tile => !jokerSet.has(tile))
  let defects = natural.length - new Set(natural).size
  for (const suit of ['m', 'p', 's']) {
    const ranks = natural.filter(tile => tile.length === 2 && tile[0] === suit).map(tile => Number(tile[1])).sort((a, b) => a - b)
    for (let index = 1; index < ranks.length; index += 1) if (ranks[index] - ranks[index - 1] < 3) defects += 1
  }
  const honorsHeld = HONORS.filter(h => natural.includes(h)).length
  const jokerCount = hand.length - natural.length
  const honorShortfall = Math.max(0, 7 - honorsHeld)
  const jokersAfterHonors = Math.max(0, jokerCount - honorShortfall)
  return Math.max(0, defects - jokersAfterHonors) === 0
}

export interface WinIncomeEstimate {
  paymentPerPayer: number
  total: number
  multiplier: number
  hardLikely: boolean
}

/** 完整 14 张的快速收益估算：番型权重 × 事件倍率 × 硬胡近似 × 每人封顶。 */
export function estimateWinIncome(
  hand: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[],
  source: WinSource,
): WinIncomeEstimate {
  const patterns = certainPatterns(hand, melds, jokers)
  let multiplier = 1
  for (const id of patterns) multiplier += BLOOD_FLOW_CONFIG.patterns[id].weight - 1
  const hardLikely = !hand.some(tile => wildcardSet(jokers).has(tile))
  const eventMultiplier = BLOOD_FLOW_CONFIG.eventMultipliers[source]
  const finalMultiplier = Math.min(multiplier * eventMultiplier * (hardLikely ? 2 : 1), BLOOD_FLOW_CONFIG.maxMultiplierPerPayer)
  const paymentPerPayer = BLOOD_FLOW_CONFIG.basePoints * finalMultiplier
  const payers = source === 'self-draw' || source === 'kong-bloom' ? 3 : 1
  return { paymentPerPayer, total: paymentPerPayer * payers, multiplier: finalMultiplier, hardLikely }
}

// ── 连锁期望与听口缓存 ──

const waitingCache = new Map<string, TileType[]>()

export function waitingTilesCached(hand: readonly TileType[], exposedMelds: number, jokers: readonly TileType[]): TileType[] {
  const key = `${exposedMelds}|${[...jokers].sort().join(',')}|${[...hand].sort().join(',')}`
  const cached = waitingCache.get(key)
  if (cached) return cached
  const waits = waitingTiles([...hand], exposedMelds, [...jokers])
  if (waitingCache.size >= 20_000) waitingCache.delete(waitingCache.keys().next().value!)
  waitingCache.set(key, waits)
  return waits
}

function remainingCount(tile: TileType, visibleTiles: readonly TileType[]) {
  return Math.max(0, 4 - matchingCount(visibleTiles, tile))
}

/** 锁手后继续胡的连锁期望（点）：听口 × 剩余张 × 每张期望收入 × 展望系数。 */
export function chainEvEst(
  hand: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[],
  visibleTiles: readonly TileType[], wallCount: number,
) {
  if (!hand.length) return 0
  const waits = waitingTilesCached(hand, melds.length, jokers)
  if (!waits.length) return 0
  const chainFactor = Math.min(1, BLOOD_FLOW_AI.chainHorizon / Math.max(1, wallCount / 4))
  let total = 0
  for (const tile of waits) {
    const remaining = remainingCount(tile, visibleTiles)
    if (!remaining) continue
    const self = estimateWinIncome([...hand, tile], melds, jokers, 'self-draw')
    const discard = estimateWinIncome([...hand, tile], melds, jokers, 'discard')
    const average = (BLOOD_FLOW_AI.selfDrawWeight * self.total + discard.total) / (BLOOD_FLOW_AI.selfDrawWeight + 1)
    total += remaining * average * chainFactor
  }
  return total
}

/** 听口是否覆盖全部 34 种（单吊任意听 / 九莲形态）。 */
export function isAnyTileWait(waits: readonly TileType[]) {
  return waits.length >= TILE_TYPES.length
}
