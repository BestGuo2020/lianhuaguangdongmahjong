// 「莲花麻将」纯规则核心（旧版翻精规则，独立引擎）。
// 与现行「莲花广麻」的 rules.ts 解耦：本局癞子（精）由开局翻牌动态决定，
// 以 `jokers: TileType[]` 传入各判定函数。只做「看手牌 → 判定/番数」的纯函数，
// 不触碰任何游戏状态，因此可独立单元测试。
import type { TileType } from '../../core/contracts/types'
import { HONORS, SUITS, TILE_TYPES } from '../../core/rules/tiles'
import { consumeTile, countTiles, firstRemainingTile, matchingCount } from '../../shared/rules/tileTools'
import type { RuleEvaluationContext, RuleSet } from '../../core/rules/ruleset'

export { matchingCount }

// ── 癞子（精）判定 ──────────────────────────────────────────────

/** 同序下一张：数牌 1→…→9→1；风 东南西北循环；箭 中发白循环。 */
export function nextInSequence(tile: TileType): TileType {
  const suited = /^([mps])([1-9])$/.exec(tile)
  if (suited) {
    const next = Number(suited[2]) === 9 ? 1 : Number(suited[2]) + 1
    return `${suited[1]}${next}` as TileType
  }
  const winds = ['east', 'south', 'west', 'north']
  if (winds.includes(tile)) return winds[(winds.indexOf(tile) + 1) % 4] as TileType
  const dragons = ['red', 'green', 'white']
  if (dragons.includes(tile)) return dragons[(dragons.indexOf(tile) + 1) % 3] as TileType
  return tile
}

/** 本局癞子 = [指示牌, 同序下一张]（恰 2 张，二者不同）。
 * 白板翻精：指示牌是白板 → 精牌 = [白板, 红中]（箭循环白→中），白板本身作为精
 * （可替代任意牌）。此前把白板从精牌里过滤掉（只留红中），导致白板翻精时不作精。 */
export function computeJokers(flipTile: TileType): TileType[] {
  return [...new Set([flipTile, nextInSequence(flipTile)])]
}

export function isJoker(tile: TileType, jokers: TileType[]): boolean {
  return jokers.includes(tile)
}

function effectiveJokers(jokers: TileType[], jokerSubstitutes: TileType[] = []) {
  return [...new Set([...jokers, ...jokerSubstitutes])]
}

function countAvailableTiles(hand: TileType[], candidates: TileType[], ordinaryJokers: TileType[] = []) {
  const ordinaryCounts = new Map<TileType, number>()
  ordinaryJokers.forEach((tile) => ordinaryCounts.set(tile, (ordinaryCounts.get(tile) ?? 0) + 1))
  let count = 0
  for (let index = hand.length - 1; index >= 0; index -= 1) {
    const tile = hand[index]
    const ordinary = ordinaryCounts.get(tile) ?? 0
    if (ordinary > 0) {
      ordinaryCounts.set(tile, ordinary - 1)
    } else if (candidates.includes(tile)) {
      count += 1
    }
  }
  return count
}

function wildcardCounts(hand: TileType[], jokers: TileType[], ordinaryJokers: TileType[], jokerSubstitutes: TileType[]) {
  const physicalSubstitutes = jokerSubstitutes.filter((tile) => !jokers.includes(tile))
  return {
    unrestricted: countAvailableTiles(hand, jokers, ordinaryJokers),
    limited: countAvailableTiles(hand, physicalSubstitutes, ordinaryJokers),
    // 白板可替代两张精牌及白板本身；精牌自身仍由 unrestricted 处理。
    limitedTiles: [...new Set([...jokers, ...physicalSubstitutes])],
  }
}

/** Keep selected joker instances as natural tiles (for a discard/robbed-kong tile). */
function naturalTiles(hand: TileType[], jokers: TileType[], ordinaryJokers: TileType[] = [], jokerSubstitutes: TileType[] = []) {
  const allJokers = effectiveJokers(jokers, jokerSubstitutes)
  const ordinaryCounts = new Map<TileType, number>()
  ordinaryJokers.forEach((tile) => ordinaryCounts.set(tile, (ordinaryCounts.get(tile) ?? 0) + 1))
  const ordinaryIndexes = new Set<number>()
  // 外部加入的牌在 winHand 末尾，倒序消费才能保留手牌中原有精牌的万能身份。
  for (let index = hand.length - 1; index >= 0; index -= 1) {
    const tile = hand[index]
    if (!isJoker(tile, allJokers)) continue
    const remaining = ordinaryCounts.get(tile) ?? 0
    if (remaining <= 0) continue
    ordinaryCounts.set(tile, remaining - 1)
    ordinaryIndexes.add(index)
  }
  return hand.filter((tile, index) => !isJoker(tile, allJokers) || ordinaryIndexes.has(index))
}

// ── 平胡面子分解（乱风顺 / 三元顺 / 癞子补缺）──────────────────────────

const WIND_CYCLE: TileType[] = ['east', 'south', 'west', 'north']
const DRAGONS: TileType[] = ['red', 'green', 'white']

export type BasePattern = 'pinghu' | 'sevenPairs' | 'shiSanLan' | 'qiXing' | 'thirteenOrphans'

export interface PatternResult {
  pattern: BasePattern
  fan: number
}

const PATTERN_LABELS: Record<BasePattern, string> = {
  pinghu: '平胡',
  sevenPairs: '七对子',
  shiSanLan: '十三烂',
  qiXing: '七星十三烂',
  thirteenOrphans: '十三幺',
}

export function patternLabel(pattern: BasePattern) {
  return PATTERN_LABELS[pattern]
}

/** 自然牌中序最低的一张（癞子面已从 naturals 中剔除，不会出现在 counts 中）。 */
/**
 * 回溯分解：把自然牌拆成 needed 组面子，缺张用 jokers 张万能牌补齐。
 * 面子候选：①三张刻子（癞子补足）②数牌顺子（癞子补缺）③乱风顺（任意 3 种不同风）
 * ④三元顺（中发白）。以「序最低自然牌」为锚 + 消耗式递归，天然避免同一张牌被
 * 重复计入刻子与乱风。
 */
export function canMakeMelds(
  counts: Map<TileType, number>,
  jokers: number,
  needed: number,
  limitedJokers = 0,
  limitedTiles: TileType[] = [],
  memo = new Map<string, boolean>(),
): boolean {
  const signature = `${needed}|${jokers}|${limitedJokers}|${TILE_TYPES.map((tile) => counts.get(tile) || 0).join('')}`
  if (memo.has(signature)) return memo.get(signature)!

  const tile = firstRemainingTile(counts, TILE_TYPES)
  if (!tile) {
    const result = jokers + limitedJokers === needed * 3
    memo.set(signature, result)
    return result
  }
  if (needed <= 0) {
    memo.set(signature, false)
    return false
  }

  const amount = counts.get(tile) || 0

  const fillMissing = (missing: TileType[], next: Map<TileType, number>) => {
    const limitedMissing = missing.filter((item) => limitedTiles.includes(item)).length
    const minLimited = Math.max(0, missing.length - jokers)
    const maxLimited = Math.min(limitedJokers, limitedMissing)
    for (let usedLimited = minLimited; usedLimited <= maxLimited; usedLimited += 1) {
      const usedJokers = missing.length - usedLimited
      if (canMakeMelds(next, jokers - usedJokers, needed - 1, limitedJokers - usedLimited, limitedTiles, memo)) return true
    }
    return false
  }

  // (1) 刻子：三张相同，癞子补足
  const realTriplet = Math.min(3, amount)
  if (
    3 - realTriplet <= jokers + limitedJokers
    && fillMissing(Array.from({ length: 3 - realTriplet }, () => tile), consumeTile(counts, tile, realTriplet))
  ) {
    memo.set(signature, true)
    return true
  }

  // (2) 数牌顺子：以当前牌 rank 覆盖的窗口
  const suited = /^([mps])([1-9])$/.exec(tile)
  if (suited) {
    const rank = Number(suited[2])
    for (let start = Math.max(1, rank - 2); start <= Math.min(7, rank); start += 1) {
      const sequence = Array.from(
        { length: 3 },
        (_, index) => `${suited[1]}${start + index}` as TileType,
      )
      let next = new Map(counts)
      const missing: TileType[] = []
      sequence.forEach((item) => {
        if ((next.get(item) || 0) > 0) next = consumeTile(next, item, 1)
        else missing.push(item)
      })
      if (missing.length <= jokers + limitedJokers && fillMissing(missing, next)) {
        memo.set(signature, true)
        return true
      }
    }
  }

  // (3) 乱风顺：任意 3 种不同风牌（锚定当前最低风牌，从其余 3 风取 2）
  if (WIND_CYCLE.includes(tile)) {
    const others = WIND_CYCLE.filter((wind) => wind !== tile)
    for (let a = 0; a < others.length; a += 1) {
      for (let b = a + 1; b < others.length; b += 1) {
        let next = new Map(counts)
        const missing: TileType[] = []
        for (const wind of [tile, others[a], others[b]]) {
          if ((next.get(wind) || 0) > 0) next = consumeTile(next, wind, 1)
          else missing.push(wind)
        }
        if (missing.length <= jokers + limitedJokers && fillMissing(missing, next)) {
          memo.set(signature, true)
          return true
        }
      }
    }
  }

  // (4) 三元顺：中发白组成一组面子
  if (DRAGONS.includes(tile)) {
    let next = new Map(counts)
    const missing: TileType[] = []
    for (const dragon of DRAGONS) {
      if ((next.get(dragon) || 0) > 0) next = consumeTile(next, dragon, 1)
      else missing.push(dragon)
    }
    if (missing.length <= jokers + limitedJokers && fillMissing(missing, next)) {
      memo.set(signature, true)
      return true
    }
  }

  memo.set(signature, false)
  return false
}

/** 平胡：4 - exposedMeldCount 组面子 + 1 对将。将可为自然对 / 单张+1癞 / 2癞。 */
export function canMakePinghu(naturals: TileType[], jokerCount: number, neededMelds: number, limitedJokerCount = 0, limitedTiles: TileType[] = []): boolean {
  const counts = countTiles(naturals)
  for (const tile of TILE_TYPES) {
    const naturalPair = Math.min(2, counts.get(tile) || 0)
    const missing = 2 - naturalPair
    const limitedForPair = limitedTiles.includes(tile) ? Math.min(missing, limitedJokerCount) : 0
    const unrestrictedForPair = missing - limitedForPair
    if (unrestrictedForPair <= jokerCount && canMakeMelds(
      consumeTile(counts, tile, naturalPair),
      jokerCount - unrestrictedForPair,
      neededMelds,
      limitedJokerCount - limitedForPair,
      limitedTiles,
    )) return true
  }
  return false
}

// ── 特殊牌型 ─────────────────────────────────────────────────────

/** 七对子：恰好 14 张；单张可与 1 张癞子配对，余下癞子须两两成对。 */
export function isSevenPairs(hand: TileType[], jokers: TileType[], ordinaryJokers: TileType[] = [], jokerSubstitutes: TileType[] = []): boolean {
  if (hand.length !== 14) return false
  const naturals = naturalTiles(hand, jokers, ordinaryJokers, jokerSubstitutes)
  const { unrestricted, limited, limitedTiles } = wildcardCounts(hand, jokers, ordinaryJokers, jokerSubstitutes)
  let pairs = 0
  let singles = 0
  let eligibleSingles = 0
  for (const count of countTiles(naturals).values()) {
    if (count === 2) pairs += 1
    else if (count === 4) pairs += 2
    else if (count === 3) { pairs += 1; singles += 1 }
    else if (count === 1) singles += 1
  }
  for (const [tile, count] of countTiles(naturals)) {
    if ((count === 1 || count === 3) && limitedTiles.includes(tile)) eligibleSingles += 1
  }
  for (let limitedForSingles = 0; limitedForSingles <= Math.min(limited, eligibleSingles); limitedForSingles += 1) {
    const requiredUnrestricted = singles - limitedForSingles
    if (requiredUnrestricted > unrestricted) continue
    const remainingUnrestricted = unrestricted - requiredUnrestricted
    const remainingLimited = limited - limitedForSingles
    const remainingWildcards = remainingUnrestricted + remainingLimited
    if (remainingWildcards % 2 !== 0) continue
    if (remainingUnrestricted === 0 && remainingLimited === 1) continue
    return true
  }
  return false
}

/**
 * 十三烂：14 张、全不重复、同花色相邻点数至少相差 3。
 * 精牌可以替代任意一张尚未出现的牌；字牌无点数，数量不限。
 */
function hasShiSanLanSpacing(tiles: TileType[]): boolean {
  const seen = new Set<TileType>()
  for (const tile of tiles) {
    if (seen.has(tile)) return false
    seen.add(tile)
  }
  for (const suit of SUITS) {
    // 必须精确匹配数牌（2 字符且首字为花色）：startsWith('s') 会误把 'south' 当数牌。
    const ranks = tiles
      .filter((tile) => tile.length === 2 && tile[0] === suit)
      .map((tile) => Number(tile[1]))
      .sort((a, b) => a - b)
    for (let i = 1; i < ranks.length; i += 1) {
      if (ranks[i] - ranks[i - 1] < 3) return false
    }
  }
  return true
}

/**
 * 十三烂 / 七星十三烂的共用判定骨架。
 * naturals 先剔除精面/白板面并满足数牌间距；精牌（含白板 limited）随后填入
 * 未占用的牌面。requireSevenHonors 时，最终 14 张牌须包含东南西北中发白 7 个字
 * ——七字允许由精牌替补，不要求物理齐全。
 */
function hasShiSanLanShape(
  hand: TileType[],
  jokers: TileType[],
  ordinaryJokers: TileType[],
  jokerSubstitutes: TileType[],
  requireSevenHonors: boolean,
): boolean {
  if (hand.length !== 14) return false

  const naturals = naturalTiles(hand, jokers, ordinaryJokers, jokerSubstitutes)
  if (!hasShiSanLanSpacing(naturals)) return false

  const { unrestricted, limited, limitedTiles } = wildcardCounts(hand, jokers, ordinaryJokers, jokerSubstitutes)
  const used = new Set<TileType>(naturals)
  const memo = new Set<string>()

  function fillJokers(unrestrictedRemaining: number, limitedRemaining: number): boolean {
    if (unrestrictedRemaining === 0 && limitedRemaining === 0) {
      return !requireSevenHonors || HONORS.every((honor) => used.has(honor))
    }
    const key = `${unrestrictedRemaining}:${limitedRemaining}:${[...used].sort().join(',')}`
    if (memo.has(key)) return false
    memo.add(key)

    const candidates = limitedRemaining > 0 ? limitedTiles : TILE_TYPES
    for (const candidate of candidates) {
      if (used.has(candidate)) continue
      used.add(candidate)
      if (hasShiSanLanSpacing([...used])
        && fillJokers(unrestrictedRemaining - (limitedRemaining > 0 ? 0 : 1), limitedRemaining - (limitedRemaining > 0 ? 1 : 0))) return true
      used.delete(candidate)
    }
    return false
  }

  // Limited whiteboards are tried first; unrestricted jokers can still fill any remaining slot.
  return fillJokers(unrestricted, limited)
}

export function isShiSanLan(hand: TileType[], jokers: TileType[] = [], ordinaryJokers: TileType[] = [], jokerSubstitutes: TileType[] = []): boolean {
  return hasShiSanLanShape(hand, jokers, ordinaryJokers, jokerSubstitutes, false)
}

/** 七星十三烂 = 十三烂 + 东南西北中发白 七字全有（七字允许精牌替补，不要求物理齐全）。 */
export function isQiXingShiSanLan(
  hand: TileType[],
  jokers: TileType[] = [],
  ordinaryJokers: TileType[] = [],
  jokerSubstitutes: TileType[] = [],
): boolean {
  return hasShiSanLanShape(hand, jokers, ordinaryJokers, jokerSubstitutes, true)
}

const THIRTEEN_ORPHAN_TILES: TileType[] = [
  'm1', 'm9', 'p1', 'p9', 's1', 's9',
  'east', 'south', 'west', 'north', 'red', 'green', 'white',
]

/** 十三幺：门前清，13 种幺九/字牌全有且其一成对（14 张内唯一重复）。精牌可替补缺失的幺九牌。 */
export function isThirteenOrphans(
  hand: TileType[],
  jokers: TileType[] = [],
  ordinaryJokers: TileType[] = [],
  jokerSubstitutes: TileType[] = [],
): boolean {
  if (hand.length !== 14) return false
  const naturals = naturalTiles(hand, jokers, ordinaryJokers, jokerSubstitutes)
  // 非幺九牌不能混入；每种幺九牌最多 2 张（唯一一对）。
  if (naturals.some((tile) => !THIRTEEN_ORPHAN_TILES.includes(tile))) return false
  const counts = countTiles(naturals)
  if (THIRTEEN_ORPHAN_TILES.some((tile) => (counts.get(tile) || 0) > 2)) return false

  const { unrestricted, limited, limitedTiles } = wildcardCounts(hand, jokers, ordinaryJokers, jokerSubstitutes)
  // 白板（limited）只能替补精牌面或白板本身；只有属于幺九牌的候选才可用。
  const limitedCandidates = limitedTiles.filter((tile) => THIRTEEN_ORPHAN_TILES.includes(tile))

  // 缺失的幺九牌种类必须由精牌补齐。
  const missing = THIRTEEN_ORPHAN_TILES.filter((tile) => (counts.get(tile) || 0) === 0)
  // 已有成对（count === 2）时，精牌只需补缺；否则还需一张精牌补成对子。
  const alreadyPaired = THIRTEEN_ORPHAN_TILES.some((tile) => (counts.get(tile) || 0) === 2)
  const totalWildcards = unrestricted + limited
  if (missing.length > totalWildcards) return false
  const spare = totalWildcards - missing.length
  if (alreadyPaired ? spare !== 0 : spare !== 1) return false

  // limited 只能补 limitedCandidates 中的种类：缺字中不属于 limitedCandidates 的必须用 unrestricted。
  const missingLimitedEligible = missing.filter((tile) => limitedCandidates.includes(tile)).length
  const missingUnrestrictedOnly = missing.length - missingLimitedEligible
  if (missingUnrestrictedOnly > unrestricted) return false
  // 成对那张：unrestricted 补缺后仍有余量可直接补任意已有 1 张的种类；
  // 否则需 limited 补缺后仍有余量，且该 limited 能补到某个最终为 1 张的 limitedCandidates 种类。
  if (alreadyPaired) return true
  if (unrestricted - missingUnrestrictedOnly >= 1) return true
  return limited >= missingLimitedEligible + 1
    && (missingLimitedEligible >= 1 || limitedCandidates.some((tile) => (counts.get(tile) || 0) === 1))
}

/**
 * 完整胡牌判定。特殊牌型仅在门前清（exposedMeldCount === 0 且 14 张）时判定，
 * 优先级：十三幺(8) > 七星十三烂(4) > 十三烂(2) > 七对子(2) > 平胡(1)。
 */
export function evaluateBasePattern(
  hand: TileType[],
  exposedMeldCount: number,
  jokers: TileType[],
  ordinaryJokers: TileType[] = [],
  jokerSubstitutes: TileType[] = [],
): PatternResult | null {
  if (exposedMeldCount === 0 && hand.length === 14) {
    if (isThirteenOrphans(hand, jokers, ordinaryJokers, jokerSubstitutes)) return { pattern: 'thirteenOrphans', fan: 8 }
    if (isQiXingShiSanLan(hand, jokers, ordinaryJokers, jokerSubstitutes)) return { pattern: 'qiXing', fan: 4 }
    if (isShiSanLan(hand, jokers, ordinaryJokers, jokerSubstitutes)) return { pattern: 'shiSanLan', fan: 2 }
    if (isSevenPairs(hand, jokers, ordinaryJokers, jokerSubstitutes)) return { pattern: 'sevenPairs', fan: 2 }
  }
  const neededMelds = 4 - exposedMeldCount
  if (hand.length !== neededMelds * 3 + 2) return null
  const naturals = naturalTiles(hand, jokers, ordinaryJokers, jokerSubstitutes)
  const { unrestricted, limited, limitedTiles } = wildcardCounts(hand, jokers, ordinaryJokers, jokerSubstitutes)
  return canMakePinghu(naturals, unrestricted, neededMelds, limited, limitedTiles)
    ? { pattern: 'pinghu', fan: 1 }
    : null
}

export function isWinningHand(hand: TileType[], exposedMeldCount: number, jokers: TileType[], ordinaryJokers: TileType[] = [], jokerSubstitutes: TileType[] = []): boolean {
  return evaluateBasePattern(hand, exposedMeldCount, jokers, ordinaryJokers, jokerSubstitutes) !== null
}

// ── 番数与收付 ──────────────────────────────────────────────────────

export interface ScoreFlags {
  dealer: boolean
  selfDraw: boolean
  robbedKong: boolean
  kongBloom: boolean
  tianhu: boolean
  dihu: boolean
}

export interface FanPattern {
  label: string
  multiplier?: number
  points?: number
}

export interface WinSettlement {
  H: number
  dealerPays: number
  nonDealerPays: number
  total: number
}

export interface FanResult {
  /** 展示番数 = baseFan × 各加计倍数的连乘（与 scoreHand.multiplier 一致）。 */
  fan: number
  /** 基础番数（1/2/4/8），驱动收付表 H。 */
  baseFan: number
  patterns: FanPattern[]
  settlement: WinSettlement
}

/**
 * 胡牌收付表（§7）：无论点炮还是自摸，未胡三家都要支付。
 * H = 100 × 基础番数。
 */
export function winPayments(
  baseFan: number,
  opts: { winnerIsDealer: boolean; selfDrawStyle: boolean },
): WinSettlement {
  const H = 100 * baseFan
  if (!opts.winnerIsDealer && !opts.selfDrawStyle) {
    return { H, dealerPays: 2 * H, nonDealerPays: H, total: 4 * H }      // 闲点炮胡
  }
  if (opts.winnerIsDealer && !opts.selfDrawStyle) {
    return { H, dealerPays: 0, nonDealerPays: 2 * H, total: 4 * H }      // 庄点炮胡
  }
  if (!opts.winnerIsDealer && opts.selfDrawStyle) {
    return { H, dealerPays: 4 * H, nonDealerPays: 2 * H, total: 8 * H }  // 闲自摸/地胡/闲抢杠
  }
  return { H, dealerPays: 0, nonDealerPays: 4 * H, total: 12 * H }       // 庄自摸/天胡
}

/**
 * 结算详情。天胡/地胡：平收 8 番，不叠加庄家/自摸等翻倍（文档 §3）。
 * 其余：抢杠胡与杠上开花均「加计自摸和庄家」，即自摸 ×2 之外再各自 ×2。
 * 若手牌并非可胡牌型返回 null（调用方应已确认胡牌）。
 */
export function scoreFan(
  hand: TileType[],
  exposedMeldCount: number,
  jokers: TileType[],
  flags: ScoreFlags,
  ordinaryJokers: TileType[] = [],
  jokerSubstitutes: TileType[] = [],
): FanResult | null {
  if (flags.tianhu || flags.dihu) {
    const label = flags.tianhu ? '天胡' : '地胡'
    return {
      fan: 8,
      baseFan: 8,
      patterns: [{ label, multiplier: 8 }],
      settlement: winPayments(8, { winnerIsDealer: flags.tianhu, selfDrawStyle: true }),
    }
  }
  const base = evaluateBasePattern(hand, exposedMeldCount, jokers, ordinaryJokers, jokerSubstitutes)
  if (!base) return null
  let fan = base.fan
  const patterns: FanPattern[] = [{ label: PATTERN_LABELS[base.pattern], multiplier: base.fan }]
  const selfDrawStyle = flags.selfDraw || flags.robbedKong || flags.kongBloom
  if (selfDrawStyle) {
    fan *= 2
    patterns.push({ label: '自摸', multiplier: 2 })
  }
  if (flags.robbedKong) {
    fan *= 2
    patterns.push({ label: '抢杠胡', multiplier: 2 })
  }
  if (flags.kongBloom) {
    fan *= 2
    patterns.push({ label: '杠上开花', multiplier: 2 })
  }
  if (flags.dealer) {
    fan *= 2
    patterns.push({ label: '庄家', multiplier: 2 })
  }
  return {
    fan,
    baseFan: base.fan,
    patterns,
    settlement: winPayments(base.fan, { winnerIsDealer: flags.dealer, selfDrawStyle }),
  }
}

// ── 听牌 ─────────────────────────────────────────────────────────

/** 列出补入后能胡的牌（34 种候选；癞子面也可是听口，因为会增加癞子数）。 */
export function waitingTiles(hand: TileType[], exposedMeldCount: number, jokers: TileType[], jokerSubstitutes: TileType[] = ['white']): TileType[] {
  return TILE_TYPES.filter((tile) => isWinningHand([...hand, tile], exposedMeldCount, jokers, [], jokerSubstitutes))
}

export interface TingEntry {
  tile: TileType
  fan: number
  pattern: string
  count: number
}

/**
 * 玩家 0 的听牌展示（§8）：对每个手牌候选「打出某张后听哪些牌」。
 * visibleCounts = 自己手牌 + 所有弃牌/副露中的张数（由调用方传入，他人暗手不计）。
 * 剩余可见张 = 4 - 自己手牌中该牌数量 - 桌面可见该牌数量。
 */
export function computeTingInfo(
  hand: TileType[],
  exposedMeldCount: number,
  jokers: TileType[],
  visibleCounts: ReadonlyMap<TileType, number>,
  jokerSubstitutes: TileType[] = [],
): Map<TileType, TingEntry[]> {
  const result = new Map<TileType, TingEntry[]>()
  const seen = new Set<TileType>()
  hand.forEach((candidate, index) => {
    if (seen.has(candidate)) return
    seen.add(candidate)
    const remaining = hand.filter((_, i) => i !== index)
    const entries: TingEntry[] = []
    for (const winTile of TILE_TYPES) {
      const completed = [...remaining, winTile]
      const base = evaluateBasePattern(completed, exposedMeldCount, jokers, [], jokerSubstitutes)
      if (!base) continue
      const held = matchingCount(remaining, winTile)
      const visible = visibleCounts.get(winTile) ?? 0
      const count = Math.max(0, 4 - held - visible)
      entries.push({ tile: winTile, fan: base.fan, pattern: PATTERN_LABELS[base.pattern], count })
    }
    if (entries.length) {
      entries.sort((a, b) => b.count - a.count || TILE_TYPES.indexOf(a.tile) - TILE_TYPES.indexOf(b.tile))
      result.set(candidate, entries)
    }
  })
  return result
}

// ── 吃 / 碰 / 杠 合法性 ──────────────────────────────────────────────

/** 碰：手中有至少两张与该弃牌相同的牌；精牌在此按自身牌面作为普通牌使用。 */
export function canPeng(hand: TileType[], tile: TileType, _jokers: TileType[]): boolean {
  return matchingCount(hand, tile) >= 2
}

export interface ChiMeld {
  kind: 'sequence' | 'wind' | 'dragon'
  tiles: TileType[]
}

/**
 * 吃：返回含被弃牌的具体吃面子（仅下家可吃，判定由回合层负责）。
 * 数牌顺子窗口 / 乱风吃（任意 3 种不同风）/ 箭牌吃（中发白）。吃面子为落地牌，
 * 精牌参与吃牌时按自身牌面作为普通牌使用，不再作为万能牌替代其他牌。
 */
export function canChi(hand: TileType[], tile: TileType, _jokers: TileType[]): ChiMeld[] {
  const results: ChiMeld[] = []
  const suited = /^([mps])([1-9])$/.exec(tile)
  if (suited) {
    const rank = Number(suited[2])
    for (let start = Math.max(1, rank - 2); start <= Math.min(7, rank); start += 1) {
      const meld = Array.from({ length: 3 }, (_, index) => `${suited[1]}${start + index}` as TileType)
      const companions = meld.filter((item) => item !== tile)
      if (companions.every((item) => matchingCount(hand, item) >= 1)) {
        results.push({ kind: 'sequence', tiles: meld })
      }
    }
  } else if (WIND_CYCLE.includes(tile)) {
    const others = WIND_CYCLE.filter((wind) => wind !== tile)
    for (let a = 0; a < others.length; a += 1) {
      for (let b = a + 1; b < others.length; b += 1) {
        if (matchingCount(hand, others[a]) >= 1 && matchingCount(hand, others[b]) >= 1) {
          results.push({ kind: 'wind', tiles: [tile, others[a], others[b]] })
        }
      }
    }
  } else if (DRAGONS.includes(tile)) {
    const others = DRAGONS.filter((dragon) => dragon !== tile)
    if (others.every((dragon) => matchingCount(hand, dragon) >= 1)) {
      results.push({ kind: 'dragon', tiles: [...DRAGONS] })
    }
  }
  return results
}

/** 暗杠候选：4 张相同的牌；精牌在此按自身牌面作为普通牌使用。 */
export function concealedKongs(hand: TileType[], _jokers: TileType[]): TileType[] {
  return TILE_TYPES.filter((tile) => matchingCount(hand, tile) === 4)
}

/** 风杠（乱风杠）：手牌同时持有东南西北各 1 张；精牌按自身风牌面使用。 */
export function windKong(hand: TileType[], _jokers: TileType[]): boolean {
  return WIND_CYCLE.every((wind) => matchingCount(hand, wind) >= 1)
}

export function canRobKong(hand: TileType[], kongTile: TileType, exposedMeldCount: number, jokers: TileType[], jokerSubstitutes: TileType[] = []): boolean {
  const allJokers = effectiveJokers(jokers, jokerSubstitutes)
  return isWinningHand(
    [...hand, kongTile],
    exposedMeldCount,
    jokers,
    allJokers.includes(kongTile) ? [kongTile] : [],
    jokerSubstitutes,
  )
}

/**
 * Adapter used by the core engine. The legacy Lotus implementation keeps its
 * explicit joker arguments for backwards compatibility, while the ruleset
 * boundary carries them in a context object.
 */
export const LOTUS_RULESET: RuleSet = {
  id: 'lotus-legacy',
  baseScore: 100,
  flow: {
    mode: 'single-win',
    continueAfterWin: false,
    allowMultipleWinners: false,
  },
  win: {
    isWinningHand: (tiles, exposedMeldCount = 0, context?: RuleEvaluationContext) => (
      isWinningHand(tiles, exposedMeldCount, [...(context?.jokers ?? [])], [...(context?.ordinaryJokers ?? [])], [...(context?.jokerSubstitutes ?? ['white'])])
    ),
    waitingTiles: (tiles, exposedMeldCount = 0, context?: RuleEvaluationContext) => (
      waitingTiles(tiles, exposedMeldCount, [...(context?.jokers ?? [])], [...(context?.jokerSubstitutes ?? ['white'])])
    ),
    canRobKong: (tiles, kongTile, exposedMeldCount = 0, context?: RuleEvaluationContext) => (
      canRobKong(tiles, kongTile, exposedMeldCount, [...(context?.jokers ?? [])], [...(context?.jokerSubstitutes ?? ['white'])])
    ),
    concealedKongs: (tiles) => concealedKongs(tiles, []),
    evaluatePattern: (tiles, exposedMeldCount, context?: RuleEvaluationContext) => (
      evaluateBasePattern(tiles, exposedMeldCount, [...(context?.jokers ?? [])], [...(context?.ordinaryJokers ?? [])], [...(context?.jokerSubstitutes ?? ['white'])])
    ),
  },
  fan: {
    scoreFan: (tiles, exposedMeldCount, flags, context?: RuleEvaluationContext) => scoreFan(
      tiles,
      exposedMeldCount,
      [...(context?.jokers ?? [])],
      flags,
      [...(context?.ordinaryJokers ?? [])],
      [...(context?.jokerSubstitutes ?? ['white'])],
    ),
  },
  score: {
    // Legacy scoring has its own settlement adapter; these hooks are supplied
    // so generic core consumers can still use the ruleset contract.
    scoreHand: ({ dealer = false }) => ({
      multiplier: dealer ? 2 : 1,
      totalMultiplier: dealer ? 2 : 1,
      horsePoints: 0,
      points: dealer ? 200 : 100,
      details: [{ label: '平胡', multiplier: 1 }],
    }),
    applyKongScore: (players, kongPlayerIndex, type, fromIndex = null) => {
      const payers = type === 'discard'
        ? [fromIndex]
        : players.map((_, index) => index).filter((index) => index !== kongPlayerIndex)
      const payment = type === 'concealed' ? 200 : 100
      const validPayers = payers.filter((index): index is number => Number.isInteger(index) && index !== kongPlayerIndex)
      validPayers.forEach((index) => {
        players[index].score -= payment
        players[kongPlayerIndex].score += payment
      })
      return [
        { playerIndex: kongPlayerIndex, amount: payment * validPayers.length },
        ...validPayers.map((playerIndex) => ({ playerIndex, amount: -payment })),
      ].filter(({ amount }) => amount !== 0)
    },
    applyWinScore: (players, winnerIndex, points, _payerIndex = null, dealerIndex = null) => {
      let total = 0
      players.forEach((player, index) => {
        if (index === winnerIndex) return
        const payment = index === dealerIndex ? points * 2 : points
        player.score -= payment
        total += payment
      })
      players[winnerIndex].score += total
      return total
    },
    applyWinSettlement: (players, winnerIndex, settlement, dealerIndex) => {
      let total = 0
      players.forEach((player, index) => {
        if (index === winnerIndex) return
        const payment = index === dealerIndex ? settlement.dealerPays : settlement.nonDealerPays
        if (payment <= 0) return
        player.score -= payment
        total += payment
      })
      players[winnerIndex].score += total
      return total
    },
  },
  extension: {
    patternProviders: [],
    settlementHooks: [],
  },
}
