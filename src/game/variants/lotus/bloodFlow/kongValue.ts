// 开杠价值（2026-09-13，用户定案第 3 步）：把"开杠会不会毁掉自己的手牌型"算进 EV，
// 而不是硬编码"检测到七对就禁杠"。
//
//   开杠价值 = 杠收益 − 防守风险 − 自手牌型损失
//
//   · 杠收益：即时杠分（底分 × kongPayments × 付款家数）+ 倍率加成（底分 × kongBonus × 折算权重）。
//   · 防守风险：补杠是血流唯一会把第 4 张亮出去给人抢杠的动作（明杠/暗杠/风杠不可抢）。
//   · 自手牌型损失（selfLoss，三项，全部换算成"点"与其它 EV 同口径）：
//       ① 七对 / 豪华七对潜力损失：杠会把这门路线的对子拆成副露，七对从此不可能；
//       ② 明杠破坏门清的损失：门清（1 番，2026-09-15 起为独立番种、与任何番种叠加）要求不副露，
//          任何杠都会造出一副副露（补杠除外——碰的时候门清已经没了）；
//       ③ 向听恶化：杠后的（手牌 + 副露）向听比杠前更差时，每档折算固定点数；
//          向听用"含七对/十三幺/十三烂的整车向听"，因此杠掉特殊路线会在这里再记一次结构退化。
//
// 净值为正才压过"不杠"（保留手牌继续打）；调用方再与最佳非杠候选（胡/碰/吃/弃牌）比较。
// 只服务血流本地 AI 与 LLM 候选；经典莲花麻将不注入本钩子，行为完全不变。
import type { Meld, TileType } from '../../../core/contracts/types'
import { handShanten } from '../../../shared/ai/handProgress'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_KONG_BONUS, BLOOD_FLOW_KONG_VALUE, type KongValueConfig } from './config'
import { sevenPairsPotential, waitingTilesCached, wildcardSet } from './patternPotentials'

export type KongValueKind = 'discard-gang' | 'added-kong' | 'concealed-kong' | 'wind-kong'

/** 与 config.kongPayments / kongBonus 的键映射（补杠按明杠计：牌面已亮，抢杠可抢）。 */
const KONG_KEYS: Readonly<Record<KongValueKind, { payment: 'discard' | 'added' | 'concealed' | 'wind'; bonus: 'exposed' | 'concealed' | 'wind' }>> = {
  'discard-gang': { payment: 'discard', bonus: 'exposed' },
  'added-kong': { payment: 'added', bonus: 'exposed' },
  'concealed-kong': { payment: 'concealed', bonus: 'concealed' },
  'wind-kong': { payment: 'wind', bonus: 'wind' },
}

/** 即时杠分的付款家数：大明杠只由打出者付，其余三家各付。 */
const KONG_PAYERS: Readonly<Record<KongValueKind, number>> = {
  'discard-gang': 1, 'added-kong': 3, 'concealed-kong': 3, 'wind-kong': 3,
}

export interface KongValueInput {
  kind: KongValueKind
  /** 杠前手牌（摸牌态含刚摸的那张；明杠时不含被弃出的第 4 张）。 */
  hand: readonly TileType[]
  /** 现有副露（明杠窗口为空；补杠含被补的那副碰）。 */
  melds: readonly Readonly<Meld>[]
  jokers: readonly TileType[]
  /** 明杠 = 被弃出的牌；暗杠 = 暗杠的牌；补杠 = 被补的碰牌；风杠不需要。 */
  tile?: TileType
  /** 补杠：被补的那副碰在 melds 中的位置。 */
  meldIndex?: number
  /** 公开牌（牌河 + 副露 + 已公开胡牌源），补杠抢杠风险用。 */
  publicTiles?: readonly TileType[]
  config?: KongValueConfig
}

export interface KongSelfLoss {
  /** 三项之和（点）。 */
  total: number
  /** ① 七对 / 豪华七对路线被杠拆掉的潜力损失。 */
  sevenPairs: number
  /** ② 造出副露后失去门清（1 番，独立番种）的损失。 */
  concealedHand: number
  /** ③ 向听恶化（含七对/十三幺/十三烂的整车向听），每档折算。 */
  shanten: number
  /** 人类可读的扣减原因（供日志/LLM 特征）。 */
  reasons: string[]
}

export interface KongCandidateValue {
  kind: KongValueKind
  /** 杠收益（点）。 */
  gain: number
  /** 防守风险（点）。 */
  risk: number
  selfLoss: KongSelfLoss
  /** 净开杠价值 = gain − risk − selfLoss；> 0 才值得压过"不杠"。 */
  net: number
}

function matchingCount(tiles: readonly TileType[], tile: TileType) {
  let count = 0
  for (const item of tiles) if (item === tile) count += 1
  return count
}

function removeCopies(tiles: readonly TileType[], tile: TileType, amount: number): TileType[] | null {
  const result = [...tiles]
  for (let index = 0; index < amount; index += 1) {
    const at = result.indexOf(tile)
    if (at < 0) return null
    result.splice(at, 1)
  }
  return result
}

const WINDS: readonly TileType[] = ['east', 'south', 'west', 'north']

/** 杠后的（手牌、副露）。金牌面按实体牌移除（与 engine.performKong 同口径）。 */
function postKongState(input: KongValueInput): { hand: TileType[]; melds: Meld[] } | null {
  const melds = input.melds.map(meld => ({ ...meld }))
  if (input.kind === 'discard-gang') {
    if (!input.tile) return null
    const hand = removeCopies(input.hand, input.tile, 3)
    if (!hand) return null
    melds.push({ type: 'gang', tile: input.tile, tiles: Array(4).fill(input.tile) as TileType[] })
    return { hand, melds }
  }
  if (input.kind === 'concealed-kong') {
    if (!input.tile) return null
    const hand = removeCopies(input.hand, input.tile, 4)
    if (!hand) return null
    melds.push({ type: 'angang', tile: input.tile, tiles: Array(4).fill(input.tile) as TileType[] })
    return { hand, melds }
  }
  if (input.kind === 'wind-kong') {
    let hand: TileType[] | null = [...input.hand]
    for (const wind of WINDS) hand = hand ? removeCopies(hand, wind, 1) : null
    if (!hand) return null
    melds.push({ type: 'angang', tile: WINDS[0], tiles: [...WINDS], windKong: true })
    return { hand, melds }
  }
  const meldIndex = input.meldIndex ?? melds.findIndex(meld => meld.type === 'peng' && input.hand.includes(meld.tile))
  const meld = melds[meldIndex]
  if (!meld) return null
  const hand = removeCopies(input.hand, meld.tile, 1)
  if (!hand) return null
  melds[meldIndex] = { ...meld, type: 'gang', added: true, tiles: [...meld.tiles, meld.tile] }
  return { hand, melds }
}

/**
 * 豪华七对的"四张"进度：0 = 手上没有刻子，无从谈四张；0.6 = 已有刻子（差一张，或精牌可替补成四张时直接算 1）。
 * 精牌（翻精 + 白板）允许替补凑成四张，与 catalog.ts 的判定同口径。
 */
function quadProgress(hand: readonly TileType[], wild: readonly TileType[]) {
  const wildSet = new Set(wild)
  const counts = new Map<TileType, number>()
  let jokers = 0
  hand.forEach(tile => {
    if (wildSet.has(tile)) jokers += 1
    else counts.set(tile, (counts.get(tile) ?? 0) + 1)
  })
  let triplet = false
  for (const count of counts.values()) {
    if (count >= 4) return 1
    if (count === 3) triplet = true
  }
  if (triplet && jokers >= 1) return 1
  return triplet ? 0.6 : 0
}

/**
 * 七对 / 豪华七对路线价值（番 × 接近度²，再乘底分）。
 * 任何副露都会让七对不可能，因此副露非空时该路线价值恒为 0。
 */
export function sevenPairsRouteValue(hand: readonly TileType[], melds: readonly Readonly<Meld>[], jokers: readonly TileType[]) {
  if (melds.length > 0) return 0
  const wild = [...wildcardSet(jokers)]
  const potential = sevenPairsPotential(hand, wild)
  if (potential <= 0) return 0
  const pairs = Math.min(1, potential / 28)
  const luxury = pairs * quadProgress(hand, wild)
  return BLOOD_FLOW_CONFIG.patterns.sevenPairs.weight * pairs ** 2
    + BLOOD_FLOW_CONFIG.patterns['luxury-seven-pairs'].weight * luxury ** 2
}

/** 门清（2026-09-15 起为独立番种、与任何番种叠加），这里按接近度折一个价。 */
function concealedHandLoss(hand: readonly TileType[], jokers: readonly TileType[], config: KongValueConfig) {
  const shanten = routeShanten(hand, 0, jokers)
  const progress = shanten <= 0 ? 1 : shanten === 1 ? 0.6 : shanten === 2 ? 0.35 : 0.15
  return BLOOD_FLOW_CONFIG.patterns['concealed-hand'].weight * BLOOD_FLOW_CONFIG.basePoints
    * progress * config.concealedHandFallback
}

/**
 * 含特殊牌型（七对/十三幺/十三烂）的向听：与 AI 的 evaluateHandProgress 同口径。
 * 副露非空时只有标准型（specialHands 在引擎里同样只对门清生效）。
 */
function routeShanten(hand: readonly TileType[], exposedMelds: number, jokers: readonly TileType[]) {
  return handShanten([...hand], {
    exposedMelds,
    wildcardTiles: [...wildcardSet(jokers)],
    visibleTiles: hand,
    waitingTiles: (tiles, exposed) => waitingTilesCached(tiles, exposed, jokers),
    specialHands: true,
  })
}

/** 杠收益（点）：即时杠分 + 倍率加成折算。 */
export function kongGain(kind: KongValueKind, config: KongValueConfig = BLOOD_FLOW_KONG_VALUE) {
  const keys = KONG_KEYS[kind]
  const bonusTable = BLOOD_FLOW_CONFIG.kongBonus ?? BLOOD_FLOW_KONG_BONUS
  return BLOOD_FLOW_CONFIG.basePoints * BLOOD_FLOW_CONFIG.kongPayments[keys.payment] * KONG_PAYERS[kind]
    + BLOOD_FLOW_CONFIG.basePoints * bonusTable[keys.bonus] * config.bonusWeight
}

/** 补杠抢杠风险（点）：未见张最贵，公开越多越安全（与旧口径的 publicCount 档位一致）。 */
function robKongRisk(publicCount: number, config: KongValueConfig) {
  const factor = publicCount <= 0 ? 1 : publicCount === 1 ? 0.35 : 0.15
  return config.robRisk * factor
}

export function kongSelfLoss(input: KongValueInput): KongSelfLoss {
  const config = input.config ?? BLOOD_FLOW_KONG_VALUE
  const post = postKongState(input)
  const reasons: string[] = []

  // ① 七对 / 豪华七对
  const before = sevenPairsRouteValue(input.hand, input.melds, input.jokers)
  const after = post ? sevenPairsRouteValue(post.hand, post.melds, input.jokers) : 0
  const sevenPairs = Math.max(0, before - after) * BLOOD_FLOW_CONFIG.basePoints
  if (sevenPairs > 0) reasons.push(`拆掉七对/豪华七对路线（-${Math.round(sevenPairs)}）`)

  // ② 门清（未副露 → 杠后必然有副露）
  const exposedBefore = input.melds.length === 0
  const exposedAfter = (post?.melds.length ?? input.melds.length) > 0
  const concealedHand = exposedBefore && exposedAfter ? concealedHandLoss(input.hand, input.jokers, config) : 0
  if (concealedHand > 0) reasons.push(`破坏门清（-${Math.round(concealedHand)}）`)

  // ③ 向听恶化（含七对/十三幺等特殊路线的"整车"向听；杠后必然有副露，特殊路线随之消失）
  const shantenBefore = routeShanten(input.hand, input.melds.length, input.jokers)
  const shantenAfter = post ? routeShanten(post.hand, post.melds.length, input.jokers) : shantenBefore
  const shantenStep = Math.max(0, shantenAfter - shantenBefore)
  const shanten = shantenStep * config.shantenStepLoss
  if (shanten > 0) reasons.push(`向听恶化 ${shantenStep} 档（-${Math.round(shanten)}）`)

  return { total: sevenPairs + concealedHand + shanten, sevenPairs, concealedHand, shanten, reasons }
}

/** 开杠候选的完整估值：杠收益 − 防守风险 − 自手牌型损失。 */
export function kongCandidateValue(input: KongValueInput): KongCandidateValue {
  const config = input.config ?? BLOOD_FLOW_KONG_VALUE
  const gain = kongGain(input.kind, config)
  const publicCount = input.tile ? matchingCount(input.publicTiles ?? [], input.tile) : 0
  const risk = input.kind === 'added-kong' ? robKongRisk(publicCount, config) : 0
  const selfLoss = kongSelfLoss(input)
  return { kind: input.kind, gain, risk, selfLoss, net: gain - risk - selfLoss.total }
}
