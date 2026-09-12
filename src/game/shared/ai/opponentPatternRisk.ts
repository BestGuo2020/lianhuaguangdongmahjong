// 对手牌型（大牌）风险的公共信息估算 —— 档位版，前后端同源（Python 镜像见
// backend/app/core/opponent_pattern_risk.py）。
//
// 目的：把"点炮给在做大牌的对手"从"与番型无关的常数价格"改成按公共证据分档的价格。
// 只用公共牌：对手牌河、副露明细、已胡次数 / 锁手、墙余、公开牌池。
// 严禁读取对手暗手：本模块不接收、不推断任何未公开手牌（bloodFlowSeatView 只向本家暴露 hand）。
// 纯函数、确定性、无 IO；未提供任何信号时结果与旧口径逐位一致（见 opponentPatternExposure）。
import type { TileType } from '../../core/contracts/types'

export type OpponentRiskTier = 0 | 1 | 2 | 3
export type SuitKey = 'm' | 'p' | 's'

export interface OpponentMeldView {
  type: string
  tile: TileType
  tiles: readonly TileType[]
}

/** 决策者可合法看到的对手信息（座位视图 / 规范快照同形）。 */
export interface OpponentPublicView {
  discards: readonly TileType[]
  melds: readonly OpponentMeldView[]
  /** 血流：该家本局已胡次数；非血流可省略。 */
  winCount?: number
  /** 血流：该家是否已锁手；非血流可省略。 */
  locked?: boolean
}

export interface OpponentRiskTuning {
  /** 档位倍率：1 = 平胡量级，4/16/32 ≈ 混一色 / 清一色 / 十六倍级硬胡点炮。 */
  factorTier1: number
  factorTier2: number
  factorTier3: number
  /** 染手（花色集中）嫌疑对手：非嫌疑花色牌的系数。 */
  offSuitFactor: number
  /** 与既有 safetyCostLadder 一致的基准单价（点）。 */
  exposureUnit: number
  /** 公开张数档位（0 张 / 1 张 / ≥2 张）。 */
  safetyCostNone: number
  safetyCostOne: number
  safetyCostSafe: number
  /** 锁手家的倍率档（已胡仍在听，现物不再享受折扣）。 */
  lockedTier: OpponentRiskTier
  /** 残局墙余阈值（沿用 BLOOD_FLOW_AI.lateGameWallCount）。 */
  lateGameWallCount: number
  /** 残局提速墙余阈值（原 estimateOpponentThreat 的 24）。 */
  lateThreatWallCount: number
  /** 门清读牌：牌河长度下限（低于此长度不做门清大牌读牌）。 */
  concealedRiverMin: number
  /** 字牌/幺九回避：牌河 ≥ concealedRiverMin 且字牌+幺九张数 ≤ 该值 → 十三幺 / 字一色 / 混清幺九嫌疑。 */
  honorTerminalQuiet: number
  /** 字牌/幺九为 0 且牌河 ≥ 该长度 → 高倍级（十六倍级）嫌疑。 */
  honorTerminalZeroRiver: number
  /** 逐张危险轴：十三幺 / 字一色嫌疑下中张（2-8 数牌）的系数（它们几乎不吃中张）。 */
  honorTerminalMiddleFactor: number
  /**
   * 十三幺 / 字一色轴上字牌与幺九的公开张数下限：这类牌型每种只需要一张，
   * "我手里有两张" 只降低概率、不等于安全，所以现物折扣不得归零。
   */
  honorTerminalLadderFloor: number
  /** 花色回避：牌河 ≥ concealedRiverMin 且该花色占比 ≤ 该值 → 九莲 / 门清清一色嫌疑。 */
  suitAvoidShare: number
  /** 短牌河兜底：某花色张数 ≤ 该值（占比可能高于 suitAvoidShare）→ 弱信号，别把 v1 的灵敏度丢掉。 */
  suitSparseCount: number
  /** 某花色一张没打且牌河 ≥ 该长度 → 高倍级（十六倍级）嫌疑。 */
  suitZeroRiver: number
  /** 七对嫌疑（弱信号）：中张占牌河 ≥ 该比例。 */
  middleHeavyShare: number
}

export const OPPONENT_RISK: Readonly<OpponentRiskTuning> = Object.freeze({
  factorTier1: 4,
  factorTier2: 16,
  factorTier3: 32,
  offSuitFactor: 0.5,
  exposureUnit: 40,
  safetyCostNone: 0.25,
  safetyCostOne: 0.1,
  safetyCostSafe: 0,
  lockedTier: 2,
  lateGameWallCount: 15,
  lateThreatWallCount: 24,
  concealedRiverMin: 8,
  honorTerminalQuiet: 1,
  honorTerminalZeroRiver: 10,
  honorTerminalMiddleFactor: 0.25,
  honorTerminalLadderFloor: 0.1,
  suitAvoidShare: 0.1,
  suitSparseCount: 1,
  suitZeroRiver: 12,
  middleHeavyShare: 0.75,
})

export const RISK_TIER_LABEL: Record<Exclude<OpponentRiskTier, 0>, '低' | '中' | '高'> = {
  1: '低',
  2: '中',
  3: '高',
}

export interface OpponentRiskProfile {
  /** 传入数组下标；调用方负责映射到座位 / 相对方位。 */
  index: number
  tier: OpponentRiskTier
  factor: number
  signals: readonly string[]
  suspectSuit: SuitKey | null
  /** 十三幺 / 字一色 / 混清幺九嫌疑：该家几乎不打字牌与幺九 → 中张反而便宜。 */
  avoidsHonorTerminals: boolean
  locked: boolean
}

export interface OpponentRiskInput {
  opponents: readonly OpponentPublicView[]
  wallCount: number
  tuning?: Partial<OpponentRiskTuning>
}

export interface OpponentRiskFeature {
  tier: '低' | '中' | '高'
  /** 估算单次点炮赔付（点，已按档位与公开张数折算）。 */
  payment: number
  signals: string[]
}

const SUIT_TILE = /^([mps])[1-9]$/
const NUMBERED_TILE = /^([mps])([1-9])$/
const DRAGONS: readonly TileType[] = ['red', 'green', 'white']
const WINDS: readonly TileType[] = ['east', 'south', 'west', 'north']
const SUIT_LABELS: Record<SuitKey, string> = { m: '万', p: '筒', s: '条' }

/** 幺九牌（数牌 1/9）。 */
export function isTerminalTile(tile: TileType): boolean {
  const matched = NUMBERED_TILE.exec(tile)
  return Boolean(matched && (matched[2] === '1' || matched[2] === '9'))
}

/** 字牌（风 + 箭）。 */
export function isHonorTile(tile: TileType): boolean {
  return DRAGONS.includes(tile) || WINDS.includes(tile)
}

/** 中张（数牌 2-8）：十三幺 / 字一色这类牌型几乎不需要它们。 */
export function isMiddleTile(tile: TileType): boolean {
  const matched = NUMBERED_TILE.exec(tile)
  return Boolean(matched && matched[2] !== '1' && matched[2] !== '9')
}

function tuningOf(partial?: Partial<OpponentRiskTuning>): OpponentRiskTuning {
  return partial ? { ...OPPONENT_RISK, ...partial } : OPPONENT_RISK
}

export function suitOfTile(tile: TileType): SuitKey | null {
  const matched = SUIT_TILE.exec(tile)
  return matched ? matched[1] as SuitKey : null
}

function factorFor(tier: OpponentRiskTier, tuning: OpponentRiskTuning): number {
  return tier === 3 ? tuning.factorTier3 : tier === 2 ? tuning.factorTier2 : tier === 1 ? tuning.factorTier1 : 1
}

interface MeldFacts {
  groups: number
  suitCounts: Map<SuitKey, number>
  dominantSuit: SuitKey | null
  maxShare: number
  dragonGroups: number
  windGroups: number
  honorGroups: number
}

function meldFacts(melds: readonly OpponentMeldView[]): MeldFacts {
  const suitCounts = new Map<SuitKey, number>()
  let groups = 0, dragonGroups = 0, windGroups = 0, honorGroups = 0
  for (const meld of melds) {
    if (meld.type === 'flower') continue
    const tiles = meld.tiles.length ? meld.tiles : [meld.tile]
    groups += 1
    const tile = meld.tile ?? tiles[0]
    if (DRAGONS.includes(tile)) { dragonGroups += 1; honorGroups += 1; continue }
    if (WINDS.includes(tile)) { windGroups += 1; honorGroups += 1; continue }
    for (const item of tiles) {
      const suit = suitOfTile(item)
      if (suit) suitCounts.set(suit, (suitCounts.get(suit) ?? 0) + 1)
    }
  }
  const suitedTotal = [...suitCounts.values()].reduce((sum, count) => sum + count, 0)
  let dominantSuit: SuitKey | null = null, maxCount = 0
  for (const [suit, count] of suitCounts) if (count > maxCount) { maxCount = count; dominantSuit = suit }
  return { groups, suitCounts, dominantSuit, maxShare: suitedTotal ? maxCount / suitedTotal : 0, dragonGroups, windGroups, honorGroups }
}

function suitDiscardCounts(discards: readonly TileType[]): Map<SuitKey, number> {
  const counts = new Map<SuitKey, number>()
  for (const tile of discards) {
    const suit = suitOfTile(tile)
    if (suit) counts.set(suit, (counts.get(suit) ?? 0) + 1)
  }
  return counts
}

function weakestSuit(counts: Map<SuitKey, number>): SuitKey | null {
  let weakest: SuitKey | null = null, least = Number.POSITIVE_INFINITY
  for (const suit of ['m', 'p', 's'] as SuitKey[]) {
    const count = counts.get(suit) ?? 0
    if (count < least) { least = count; weakest = suit }
  }
  return weakest
}

/**
 * 逐家估算对手牌型风险档。所有信号都来自公共牌；`tier` 取各项信号的最大值。
 * 档位含义：1 = 弱信号（门清染手 / 残局快听 / 半染手），2 = 染手或三副露或已锁手仍在听，
 * 3 = 三元 / 四喜系或十六倍级嫌疑。
 */
export function opponentRiskProfiles(input: OpponentRiskInput): OpponentRiskProfile[] {
  const tuning = tuningOf(input.tuning)
  const wallCount = input.wallCount ?? 99
  return input.opponents.map((opponent, index) => {
    const facts = meldFacts(opponent.melds)
    const discards = opponent.discards ?? []
    const signals: string[] = []
    let tier: OpponentRiskTier = 0
    let suspectSuit: SuitKey | null = null
    let avoidsHonorTerminals = false
    const raise = (next: OpponentRiskTier, signal?: string) => {
      if (next > tier) tier = next
      if (signal) signals.push(signal)
    }
    if (facts.dragonGroups >= 3) raise(3, '副露含三组箭牌')
    else if (facts.dragonGroups === 2) raise(2, '副露含两组箭牌')
    if (facts.windGroups >= 3) raise(3, '副露含三组风牌')
    else if (facts.windGroups === 2) raise(2, '副露含两组风牌')
    if (facts.honorGroups >= 3) raise(2, '副露字牌成组')
    if (facts.groups >= 3) raise(2, `副露${facts.groups}组`)
    if (facts.groups >= 2 && facts.maxShare >= 0.75) {
      raise(2, '副露染手嫌疑')
      suspectSuit = facts.dominantSuit
    } else if (facts.groups >= 2 && facts.maxShare >= 0.5) {
      raise(1, '副露半染手')
      suspectSuit = facts.dominantSuit
    }
    if (facts.groups >= 2 && discards.length >= 1 && discards.length <= 7 && wallCount > tuning.lateThreatWallCount) {
      raise(1, '副露少牌河快听')
    }
    // 门清大牌读牌（这是 tier3 唯一的来源）：牌河指纹——整局不打字牌/幺九 = 十三幺 / 字一色；
    // 某花色几乎不打 = 九莲 / 门清清一色；牌河几乎全是中张 = 七对弱信号。
    const riverLength = discards.length
    if (facts.groups === 0 && riverLength >= tuning.concealedRiverMin) {
      const honorTerminals = discards.filter(tile => isHonorTile(tile) || isTerminalTile(tile)).length
      if (honorTerminals === 0 && riverLength >= tuning.honorTerminalZeroRiver) {
        raise(3, '牌河零字牌幺九')
        avoidsHonorTerminals = true
      } else if (honorTerminals <= tuning.honorTerminalQuiet) {
        raise(2, '牌河无字牌幺九')
        avoidsHonorTerminals = true
      }
      const counts = suitDiscardCounts(discards)
      const weakest = weakestSuit(counts)
      const weakestCount = weakest ? counts.get(weakest) ?? 0 : 0
      if (weakest && weakestCount === 0 && riverLength >= tuning.suitZeroRiver) {
        raise(3, `牌河未打${SUIT_LABELS[weakest]}`)
        suspectSuit = suspectSuit ?? weakest
      } else if (weakest && weakestCount / riverLength <= tuning.suitAvoidShare) {
        raise(2, `牌河几乎未打${SUIT_LABELS[weakest]}`)
        suspectSuit = suspectSuit ?? weakest
      } else if (weakest && weakestCount <= tuning.suitSparseCount) {
        // 短牌河（8-11 张）里某花色只有 ≤1 张：占比够不上 tier2，但仍是一档弱信号（v1 灵敏度）。
        raise(1, `牌河少打${SUIT_LABELS[weakest]}`)
        suspectSuit = suspectSuit ?? weakest
      }
      const middles = discards.filter(isMiddleTile).length
      if (middles / riverLength >= tuning.middleHeavyShare) raise(1, '牌河中张密集')
    }
    if (wallCount <= tuning.lateGameWallCount && discards.length >= 1 && discards.length <= 7) raise(1, '残局少牌河')
    const winCount = opponent.winCount ?? 0
    if (opponent.locked && winCount > 0) raise(tuning.lockedTier, `已胡${winCount}次仍听`)
    return {
      index, tier, factor: factorFor(tier, tuning), signals: [...new Set(signals)],
      suspectSuit, avoidsHonorTerminals, locked: Boolean(opponent.locked && winCount > 0),
    }
  })
}

export function maxOpponentRiskTier(profiles: readonly OpponentRiskProfile[]): OpponentRiskTier {
  return profiles.reduce<OpponentRiskTier>((best, profile) => profile.tier > best ? profile.tier : best, 0)
}

function visibleCounts(visibleTiles: readonly TileType[]): Map<TileType, number> {
  const counts = new Map<TileType, number>()
  for (const tile of visibleTiles) counts.set(tile, (counts.get(tile) ?? 0) + 1)
  return counts
}

/**
 * 每张牌的估算点炮赔付（点）。
 *
 * 口径：一次弃牌最多被一家胡，所以取"权重最高的那一家"的赔付，而不是各家相加
 * （相加会把三家都危险的局面高估 3 倍，也会破坏与旧口径的等价性）。
 *
 * 与旧口径的等价性：无任何信号（全部 tier=0、无锁手）时权重恒为 1，退化为
 * `exposureUnit × ladder(公开张数)`，即改动前 `safetyExposureFor` 的逐位相同结果。
 */
export function opponentPatternExposure(
  profiles: readonly OpponentRiskProfile[],
  visibleTiles: readonly TileType[],
  tuning: Partial<OpponentRiskTuning> = {},
): (tile: TileType) => number {
  const resolved = tuningOf(tuning)
  const counts = visibleCounts(visibleTiles)
  const ladderRatio = (tile: TileType) => {
    const count = counts.get(tile) ?? 0
    return count >= 2 ? resolved.safetyCostSafe : count === 1 ? resolved.safetyCostOne : resolved.safetyCostNone
  }
  return (tile: TileType) => {
    const ladder = ladderRatio(tile)
    if (!profiles.length) return resolved.exposureUnit * ladder
    const suit = suitOfTile(tile)
    let weight = 1
    let chosen: OpponentRiskProfile | null = null
    for (const profile of profiles) {
      // 已锁手的家可能停在单吊任意听（任何一张都能胡）：现物折扣、花色折扣与危险轴折扣都不适用。
      const offSuit = !profile.locked && profile.suspectSuit !== null && suit !== profile.suspectSuit
      const inSuspectSuit = profile.suspectSuit !== null && suit === profile.suspectSuit
      let tileFactor = offSuit ? resolved.offSuitFactor : 1
      // 逐张危险轴：十三幺 / 字一色嫌疑下中张几乎不被需要 → 便宜；但嫌疑花色内的中张照价（九莲要同一花色 1-9）。
      if (!profile.locked && profile.avoidsHonorTerminals && isMiddleTile(tile) && !inSuspectSuit) {
        tileFactor *= resolved.honorTerminalMiddleFactor
      }
      const candidate = profile.factor * tileFactor
      if (candidate > weight) { weight = candidate; chosen = profile }
    }
    // 一次弃牌最多被一家胡：取权重最高的一家的口径。
    const ratio = chosen === null ? ladder
      : chosen.locked ? resolved.safetyCostNone
        // 十三幺/字一色轴上字牌与幺九保留下限：多现 ≠ 安全（该牌型每种只要一张）。
        : chosen.avoidsHonorTerminals && !isMiddleTile(tile)
          ? Math.max(ladder, resolved.honorTerminalLadderFloor)
          : ladder
    return resolved.exposureUnit * weight * ratio
  }
}

/** 该张牌的对手风险特征（供候选特征 / prompt 使用）；无信号返回 undefined。 */
export function opponentPatternFeature(
  profiles: readonly OpponentRiskProfile[],
  visibleTiles: readonly TileType[],
  tile: TileType,
  tuning: Partial<OpponentRiskTuning> = {},
): OpponentRiskFeature | undefined {
  const tier = maxOpponentRiskTier(profiles)
  if (tier === 0) return undefined
  const top = profiles.find((profile) => profile.tier === tier)
  const payment = Math.round(opponentPatternExposure(profiles, visibleTiles, tuning)(tile))
  return { tier: RISK_TIER_LABEL[tier], payment, signals: [...(top?.signals ?? [])].slice(0, 3) }
}

/** 深思门槛口径：把档位换算成 0～100 的公开威胁分（与原 estimateOpponentThreat 同量纲）。 */
export function opponentThreatScore(profiles: readonly OpponentRiskProfile[], wallCount: number): number {
  const tier = maxOpponentRiskTier(profiles)
  const base = tier === 3 ? 90 : tier === 2 ? 70 : tier === 1 ? 40 : 0
  if (!base) return 0
  return Math.min(100, base + (wallCount <= OPPONENT_RISK.lateThreatWallCount ? 10 : 0))
}
