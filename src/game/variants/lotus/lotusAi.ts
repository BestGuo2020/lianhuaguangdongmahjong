// 「莲花麻将」AI 决策层（纯函数）：看手牌/局面 → 给出动作命令，不改任何状态。
// 决策与执行分离，可独立单元测试。
import type { Meld, TileType } from '../../core/contracts/types'
import { removeMatches } from '../../core/rules/actions'
import { canPeng, concealedKongs, isWinningHand, matchingCount, waitingTiles, windKong, type ChiMeld, LOTUS_RULESET } from './lotusRules'
import type { RuleSet } from '../../core/rules/ruleset'
import { hasReadyDiscard, projectKongBloom } from './kongProjection'
import { compareHandProgress, evaluateHandProgress, type HandProgress } from '../../shared/ai/handProgress'
import { sevenPairsPotential, shiSanLanPotential, thirteenOrphansPotential } from './bloodFlow/patternPotentials'
import type { KongValueKind } from './bloodFlow/kongValue'

function wildcardSet(jokers: readonly TileType[]) {
  return new Set<TileType>([...jokers, 'white'])
}

/** Shared automation candidate policy, also used by blood-flow and deadline fallbacks. */
export function lotusDiscardCandidates(hand: readonly TileType[], jokers: readonly TileType[], allowedIndices: readonly number[] = hand.map((_, i) => i)) {
  // Only actual jokers are protected; a substitute white participates in evaluation.
  const protectedTiles = new Set(jokers)
  const candidates = [...new Set(allowedIndices)].filter(i => Number.isInteger(i) && i >= 0 && i < hand.length)
    .map(index => ({ index, tile: hand[index] }))
  const ordinary = candidates.filter(({ tile }) => !protectedTiles.has(tile))
  return ordinary.length ? ordinary : candidates
}

/** The original low-cost shape score; full decisions add ready-hand/progress quality below. */
function discardShapeScore(hand: readonly TileType[], tile: TileType) {
  const same = hand.filter(t => t === tile).length - 1
  const suited = /^([mps])([1-9])$/.exec(tile)
  let neighbors = 0
  if (suited) {
    const rank = Number(suited[2])
    neighbors += hand.includes(`${suited[1]}${rank - 1}` as TileType) ? 1 : 0
    neighbors += hand.includes(`${suited[1]}${rank + 1}` as TileType) ? 1 : 0
  }
  return same * 4 + neighbors * 2 + (suited ? 0 : 6)
}

/** Bounded common fallback: preserve jokers using the same candidates and score as the normal AI. */
export function chooseFallbackDiscardIndex(hand: readonly TileType[], jokers: readonly TileType[], allowedIndices?: readonly number[]) {
  return lotusDiscardCandidates(hand, jokers, allowedIndices)
    .sort((a, b) => discardShapeScore(hand, a.tile) - discardShapeScore(hand, b.tile) || a.index - b.index)[0]?.index ?? -1
}

const waitingCache = new Map<string, TileType[]>()

function aiWaitingTiles(hand: TileType[], exposedMelds: number, jokers: TileType[]) {
  const key = `${exposedMelds}|${[...jokers].sort().join(',')}|${[...hand].sort().join(',')}`
  const cached = waitingCache.get(key)
  if (cached) return cached
  const waits = waitingTiles(hand, exposedMelds, jokers)
  if (waitingCache.size >= 20_000) waitingCache.delete(waitingCache.keys().next().value!)
  waitingCache.set(key, waits)
  return waits
}

export type LotusTurnDecision =
  | { kind: 'win' }
  | { kind: 'added-kong'; meldIndex: number }
  | { kind: 'concealed-kong'; tile: TileType }
  | { kind: 'wind-kong' }
  | { kind: 'discard'; handIndex: number }

export type LotusClaimAction =
  | { kind: 'gang' }
  | { kind: 'peng'; discardIndex?: number }
  | { kind: 'chi'; meld: ChiMeld }
  | { kind: 'pass' }

export type LotusRobKongAction = 'win' | 'pass'

/**
 * 开杠价值钩子（第 3 步，2026-09-13）：由血流策略注入，返回开杠候选的净值
 * `杠收益 − 防守风险 − 自手牌型损失`（见 bloodFlow/kongValue.ts）。
 *
 * **不注入时经典玩法行为完全不变**：明杠仍"能杠必杠"，暗杠/风杠/补杠仍走"已听牌则放弃"的旧启发式。
 * 注入后这些动作改由净值决定（> 0 才压过"不杠"），调用方再与最佳非杠候选（胡/碰/吃/弃牌）比较。
 */
export interface KongEvaluationContext {
  kind: KongValueKind
  hand: readonly TileType[]
  melds: readonly Meld[]
  jokers: readonly TileType[]
  tile?: TileType
  /** 补杠：被补的碰在 melds 中的位置。 */
  meldIndex?: number
  publicTiles?: readonly TileType[]
}

export type KongEvaluator = (context: KongEvaluationContext) => { net: number }

export interface LotusTurnView {
  hand: TileType[]
  melds: Meld[]
  exposedMelds: number
  kongBloom: boolean
  jokers: TileType[]
  visibleTiles?: TileType[]
  publicTiles?: TileType[]
  upperLastDiscard?: TileType
  earlyRound?: boolean
  /** 剩余牌墙张数（残局节奏用） */
  wallCount?: number
  ruleset?: RuleSet
  /** 可选：番型潜力收益（点），血流策略注入；不传则行为与经典一致。 */
  patternBonus?: (hand: TileType[], melds: Meld[]) => number
  /** 可选：弃牌放炮成本（点），血流策略注入。 */
  safetyExposure?: (tile: TileType) => number
  /** 可选：开杠价值（杠收益 − 防守风险 − 自手牌型损失），血流策略注入；不传则用旧启发式。 */
  kongEvaluator?: KongEvaluator
}

export interface LotusClaimView {
  hand: TileType[]
  exposedMelds: number
  tile: TileType
  from: number
  /** 手牌中是否已有 3 张可直杠（由回合层预计算） */
  canGang: boolean
  canPeng: boolean
  chiOptions: ChiMeld[]
  jokers: TileType[]
  visibleTiles?: TileType[]
  publicTiles?: TileType[]
  upperLastDiscard?: TileType
  earlyRound?: boolean
  /** 剩余牌墙张数（残局节奏用） */
  wallCount?: number
  /** 可选：番型潜力收益（点），血流策略注入；不传则行为与经典一致。 */
  patternBonus?: (hand: TileType[], melds: Meld[]) => number
  /** 可选：弃牌放炮成本（点），血流策略注入。 */
  safetyExposure?: (tile: TileType) => number
  /** 可选：现有副露（供 patternBonus 统计杠/碰）。 */
  melds?: Meld[]
  /** 可选：开杠价值（杠收益 − 防守风险 − 自手牌型损失），血流策略注入；不传则用旧启发式。 */
  kongEvaluator?: KongEvaluator
}

export interface LotusRobKongView {
  hand: TileType[]
  exposedMelds: number
  tile: TileType
  from: number
  jokers: TileType[]
}

/**
 * 开杠是否值得（第 3 步）：注入 kongEvaluator 时按净值
 * `杠收益 − 防守风险 − 自手牌型损失` 判断——净值为正才压过"不杠"（保留手牌继续打）；
 * 没注入（经典玩法）时回退调用方给的旧启发式判断，行为不变。
 */
function acceptsKong(
  view: LotusTurnView,
  evaluator: KongEvaluator | undefined,
  context: Pick<KongEvaluationContext, 'kind' | 'melds' | 'tile' | 'meldIndex'>,
  legacy: () => boolean,
): boolean {
  if (!evaluator) return legacy()
  return evaluator({ hand: view.hand, jokers: view.jokers, publicTiles: view.publicTiles, ...context }).net > 0
}

/** 回合决策：杠后全听特例 → 自摸胡 → 补杠 → 暗杠 → 乱风杠 → 弃牌。
 * random 注入以便引擎建议确定性化；默认 Math.random 维持既有行为。 */
export function decideTurn(view: LotusTurnView, random: () => number = Math.random): LotusTurnDecision {
  const kongEvaluator = view.kongEvaluator
  const guaranteedConcealedKong = (view.ruleset ?? LOTUS_RULESET).win
    .concealedKongs(view.hand, { jokers: view.jokers })
    .find((tile) => projectKongBloom({
      kind: 'concealed-kong', hand: view.hand, exposedMelds: view.exposedMelds,
      jokers: view.jokers, tile, visibleTiles: view.visibleTiles,
    }).guaranteedKongBloom)
  if (guaranteedConcealedKong) return { kind: 'concealed-kong', tile: guaranteedConcealedKong }

  if (windKong(view.hand, view.jokers) && projectKongBloom({
    kind: 'wind-kong', hand: view.hand, exposedMelds: view.exposedMelds,
    jokers: view.jokers, visibleTiles: view.visibleTiles,
  }).guaranteedKongBloom) return { kind: 'wind-kong' }

  if ((view.ruleset ?? LOTUS_RULESET).win.isWinningHand(view.hand, view.exposedMelds, { jokers: view.jokers })) return { kind: 'win' }

  const meldIndex = view.melds.findIndex(
    (meld) => meld.type === 'peng'
      && view.hand.includes(meld.tile),
  )
  if (meldIndex >= 0 && acceptsKong(view, kongEvaluator, {
    kind: 'added-kong', melds: view.melds, tile: view.melds[meldIndex].tile, meldIndex,
  }, () => shouldTakeAddedKong(view))) return { kind: 'added-kong', meldIndex }

  const kong = (view.ruleset ?? LOTUS_RULESET).win.concealedKongs(view.hand, { jokers: view.jokers })[0]
  if (kong && acceptsKong(view, kongEvaluator, { kind: 'concealed-kong', melds: view.melds, tile: kong },
    () => shouldTakeConcealedKong(view, kong))) return { kind: 'concealed-kong', tile: kong }

  if (windKong(view.hand, view.jokers) && acceptsKong(view, kongEvaluator,
    { kind: 'wind-kong', melds: view.melds }, () => shouldTakeWindKong(view))) return { kind: 'wind-kong' }

  return {
    kind: 'discard',
    handIndex: chooseDiscardIndex(view.hand, view.jokers, random, {
      exposedMelds: view.exposedMelds,
      visibleTiles: view.visibleTiles,
      publicTiles: view.publicTiles,
      upperLastDiscard: view.upperLastDiscard,
      earlyRound: view.earlyRound,
      wallCount: view.wallCount,
      patternBonus: view.patternBonus,
      safetyExposure: view.safetyExposure,
      melds: view.melds,
    }),
  }
}

/** 当前手牌是否已听牌（存在打出某张后听口非空）。 */
function isTenpai(hand: TileType[], exposedMelds: number, jokers: TileType[]): boolean {
  return hasReadyDiscard(hand, exposedMelds, jokers)
}

/**
 * 补杠：把第 4 张亮出后别家可抢杠胡。牌河该牌出现越少，别家听它的可能性越高；
 * 若手牌已听牌，补杠会破坏手牌结构且暴露被抢风险 → 放弃。
 *
 * 血流注入 kongEvaluator 后不再走这条（改由"杠收益 − 抢杠风险 − 向听损失"定价），
 * 这里保留为经典玩法的口径。
 */
function shouldTakeAddedKong(view: LotusTurnView): boolean {
  const meld = view.melds.find((item) => item.type === 'peng')
  if (!meld) return true
  const publicCount = matchingCount(view.publicTiles ?? [], meld.tile)
  if (publicCount >= 1) return true
  return !isTenpai(view.hand, view.exposedMelds, view.jokers)
}

/** 暗杠：移除 4 张后结构大变；已听牌时杠会破坏听牌 → 放弃，未听牌则杠（+6B 收益）。
 * 血流注入 kongEvaluator 后改由开杠价值定价（手上的四张可能是豪华七对的本体）。 */
function shouldTakeConcealedKong(view: LotusTurnView, _tile: TileType): boolean {
  return !isTenpai(view.hand, view.exposedMelds, view.jokers)
}

/** 风杠：同样移除 4 张；已听牌时放弃（血流注入 kongEvaluator 后由开杠价值定价）。 */
function shouldTakeWindKong(view: LotusTurnView): boolean {
  return !isTenpai(view.hand, view.exposedMelds, view.jokers)
}

/** 面对弃牌：能杠必杠 → 能碰必碰 → 能吃则吃 → 过。 */
export function decideClaim(view: LotusClaimView): LotusClaimAction {
  // 杠后会从牌尾补牌，无法仅凭当前 13 张手牌准确判断补牌后的听口，
  // 因此继续保留杠的最高优先级；碰与吃则必须比较动作后的听牌质量。
  //
  // 第 3 步（2026-09-13）：血流注入 kongEvaluator 后，明杠也变成"计分开杠"——
  // 明杠会造出一副露（门清没了）并拆掉手上的三张（七对/豪华七对路线没了），
  // 这些损失按点折算后与"不杠"（保留手牌，即最佳非杠候选：碰/吃/过）比较，净值为正才杠。
  if (view.canGang) {
    const value = view.kongEvaluator?.({
      kind: 'discard-gang', hand: view.hand, melds: view.melds ?? [], jokers: view.jokers,
      tile: view.tile, publicTiles: view.publicTiles,
    })
    if (!value || value.net > 0) return { kind: 'gang' }
  }

  const extras: DiscardExtras = { melds: view.melds, patternBonus: view.patternBonus, safetyExposure: view.safetyExposure }
  const baseline = currentHandQuality(
    view.hand,
    view.exposedMelds,
    view.jokers,
    view.visibleTiles,
    view.publicTiles,
    view.upperLastDiscard,
    view.wallCount,
    extras,
  )
  const candidates: Array<{
    action: Exclude<LotusClaimAction, { kind: 'pass' }>
    quality: DiscardQuality
  }> = []

  if (view.canPeng && canPeng(view.hand, view.tile, view.jokers)) {
    const afterPeng = removeMatches(view.hand, view.tile, 2)
    const discard = bestDiscardAfterClaim(
      afterPeng,
      view.exposedMelds + 1,
      view.jokers,
      view.visibleTiles,
      view.earlyRound,
      view.publicTiles,
      view.upperLastDiscard,
      view.wallCount,
      extras,
    )
    if (discard) candidates.push({
      action: { kind: 'peng', discardIndex: discard.index },
      quality: discard.quality,
    })
  }

  for (const meld of view.chiOptions) {
    const afterChi = removeClaimedMeldTiles(view.hand, meld, view.tile)
    if (!afterChi) continue
    const discard = bestDiscardAfterClaim(
      afterChi,
      view.exposedMelds + 1,
      view.jokers,
      view.visibleTiles,
      view.earlyRound,
      view.publicTiles,
      view.upperLastDiscard,
      view.wallCount,
      extras,
    )
    if (discard) candidates.push({ action: { kind: 'chi', meld }, quality: discard.quality })
  }

  const best = candidates
    // 未听散手不因一阶估值就贸然开副露；至少动作后听牌，或现状本就听牌，才比较投影。
    .filter((candidate) => (candidate.quality.ready || baseline.ready)
      && compareQuality(candidate.quality, baseline) > 0)
    .sort((a, b) => compareQuality(b.quality, a.quality) || claimActionPriority(a.action) - claimActionPriority(b.action))[0]
  return best?.action ?? { kind: 'pass' }
}

function claimActionPriority(action: Exclude<LotusClaimAction, { kind: 'pass' }>) {
  return action.kind === 'peng' ? 0 : 1
}

function removeClaimedMeldTiles(hand: TileType[], meld: ChiMeld, tile: TileType): TileType[] | null {
  const remaining = [...hand]
  for (const meldTile of meld.tiles) {
    if (meldTile === tile) continue
    const index = remaining.indexOf(meldTile)
    if (index < 0) return null
    remaining.splice(index, 1)
  }
  return remaining
}

interface DiscardQuality {
  ready: boolean
  waits: TileType[]
  effectiveRemaining: number
  specialScore: number
  heuristic: number
  safetyScore: number
  netScore: number
  progress: HandProgress
}

/** 可选扩展（血流策略注入；经典调用不传，行为不变）。 */
interface DiscardExtras {
  melds?: Meld[]
  patternBonus?: (hand: TileType[], melds: Meld[]) => number
  safetyExposure?: (tile: TileType) => number
}

function emptyQuality(): DiscardQuality {
  return {
    ready: false,
    waits: [],
    effectiveRemaining: 0,
    specialScore: 0,
    heuristic: Number.POSITIVE_INFINITY,
    safetyScore: 0,
    netScore: Number.NEGATIVE_INFINITY,
    progress: { shanten: 8, waits: [], effectiveTiles: [], ukeire: 0, effectiveRemaining: 0 },
  }
}

function lotusProgress(
  hand: TileType[], exposedMelds: number, jokers: TileType[], visibleTiles: TileType[] = hand,
) {
  return evaluateHandProgress(hand, {
    exposedMelds,
    wildcardTiles: [...wildcardSet(jokers)],
    visibleTiles,
    waitingTiles: (tiles, exposed) => aiWaitingTiles(tiles, exposed, jokers),
    specialHands: true,
  })
}

function currentHandQuality(
  hand: TileType[],
  exposedMelds: number,
  jokers: TileType[],
  visibleTiles: TileType[] = hand,
  _publicTiles: TileType[] = [],
  _upperLastDiscard?: TileType,
  wallCount?: number,
  extras: DiscardExtras = {},
): DiscardQuality {
  const progress = lotusProgress(hand, exposedMelds, jokers, visibleTiles)
  const waits = progress.waits
  const specialScore = specialPatternScore(hand, exposedMelds, jokers)
  const lateGame = (wallCount ?? 99) <= 8
  const attackScore = handQualityAttackScore(waits, waits.reduce((total, tile) => total + remainingCount(tile, visibleTiles), 0), specialScore, lateGame)
  return {
    ready: waits.length > 0,
    waits,
    effectiveRemaining: waits.reduce((total, tile) => total + remainingCount(tile, visibleTiles), 0),
    specialScore,
    heuristic: 0,
    safetyScore: 0,
    netScore: attackScore + (extras.patternBonus?.(hand, extras.melds ?? []) ?? 0),
    progress,
  }
}

function compareQuality(a: DiscardQuality, b: DiscardQuality): number {
  if (a.ready !== b.ready) return a.ready ? 1 : -1
  if (a.netScore !== b.netScore) return a.netScore - b.netScore
  if (!a.ready && a.specialScore !== b.specialScore) return a.specialScore - b.specialScore
  const progress = compareHandProgress(a.progress, b.progress)
  if (progress !== 0) return progress
  if (a.effectiveRemaining !== b.effectiveRemaining) return a.effectiveRemaining - b.effectiveRemaining
  if (a.waits.length !== b.waits.length) return a.waits.length - b.waits.length
  if (a.specialScore !== b.specialScore) return a.specialScore - b.specialScore
  if (a.safetyScore !== b.safetyScore) return a.safetyScore - b.safetyScore
  return b.heuristic - a.heuristic
}

function bestDiscardAfterClaim(
  hand: TileType[],
  exposedMelds: number,
  jokers: TileType[],
  visibleTiles: TileType[] = hand,
  earlyRound = false,
  publicTiles: TileType[] = [],
  upperLastDiscard?: TileType,
  wallCount?: number,
  extras: DiscardExtras = {},
) {
  if (!hand.length) return null
  const candidates = lotusDiscardCandidates(hand, jokers)
    .map(({ tile, index }) => {
      const afterDiscard = hand.filter((_, candidateIndex) => candidateIndex !== index)
      return {
        index,
        tile,
        quality: discardQuality(
          afterDiscard,
          tile,
          exposedMelds,
          jokers,
          visibleTiles,
          earlyRound,
          publicTiles,
          upperLastDiscard,
          wallCount,
          true,
          extras,
        ),
      }
    })
  return candidates
    .sort((a, b) => compareQuality(b.quality, a.quality) || a.index - b.index)[0] ?? null
}

function discardQuality(
  afterDiscard: TileType[],
  discarded: TileType,
  exposedMelds: number,
  jokers: TileType[],
  visibleTiles: TileType[],
  earlyRound: boolean,
  publicTiles: TileType[] = [],
  upperLastDiscard?: TileType,
  wallCount?: number,
  includeProgress = true,
  extras: DiscardExtras = {},
): DiscardQuality {
  const waits = aiWaitingTiles(afterDiscard, exposedMelds, jokers)
  const effectiveRemaining = waits.reduce((total, tile) => total + remainingCount(tile, visibleTiles), 0)
  const progress = includeProgress
    ? lotusProgress(afterDiscard, exposedMelds, jokers, visibleTiles)
    : { shanten: waits.length ? 0 : 8, waits, effectiveTiles: [], ukeire: effectiveRemaining, effectiveRemaining }
  const specialScore = specialPatternScore(afterDiscard, exposedMelds, jokers)
  const safetyScore = publicSafetyScore(discarded, publicTiles, upperLastDiscard)
  const lateGame = (wallCount ?? 99) <= 8
  const attackScore = handQualityAttackScore(waits, effectiveRemaining, specialScore, lateGame)
  return {
    ready: waits.length > 0,
    waits,
    effectiveRemaining,
    specialScore,
    heuristic: discardHeuristic(afterDiscard, discarded, jokers, earlyRound),
    safetyScore,
    netScore: attackScore + safetyScore * (lateGame && waits.length ? 4 : 2)
      + (extras.patternBonus?.(afterDiscard, extras.melds ?? []) ?? 0)
      - (extras.safetyExposure?.(discarded) ?? 0),
    progress,
  }
}

function handQualityAttackScore(waits: TileType[], effectiveRemaining: number, specialScore: number, lateGame = false) {
  // 残局未听牌时更看重听口（冲牌）：攻击分整体上调。
  const readyBonus = waits.length > 0 ? 80 : 0
  const lateBonus = lateGame && waits.length > 0 ? 20 : 0
  return readyBonus + lateBonus + waits.length * 10 + effectiveRemaining * 2 + specialScore * 3
}

/**
 * 只根据牌河和公开副露评估安全度：公开出现越多越安全；上家刚打过的牌优先跟打。
 * 147 只作为软提示，不把一四七关系当成绝对安全。
 */
function publicSafetyScore(tile: TileType, publicTiles: TileType[], upperLastDiscard?: TileType) {
  const publicCount = matchingCount(publicTiles, tile)
  let score = publicCount >= 3 ? 24 : publicCount >= 2 ? 12 : publicCount >= 1 ? 4 : 0
  if (upperLastDiscard === tile) score += 12

  const suited = /^([mps])([1-9])$/.exec(tile)
  if (suited && (suited[2] === '1' || suited[2] === '7')) {
    const middle = `${suited[1]}4` as TileType
    if (publicTiles.includes(middle)) score += 5
  }
  return score
}

function remainingCount(tile: TileType, visibleTiles: TileType[]) {
  return Math.max(0, 4 - matchingCount(visibleTiles, tile))
}

/** 特殊牌型潜力：十三烂/七星十三烂、十三幺、七对子，取最高方向。 */
function specialPatternScore(hand: TileType[], exposedMelds: number, jokers: TileType[]) {
  if (exposedMelds > 0) return -20
  const effectiveJokers = [...wildcardSet(jokers)]
  return Math.max(
    shiSanLanPotential(hand, effectiveJokers),
    thirteenOrphansPotential(hand, effectiveJokers),
    sevenPairsPotential(hand, effectiveJokers),
  )
}

function discardHeuristic(hand: TileType[], discarded: TileType, jokers: TileType[], earlyRound: boolean) {
  const same = matchingCount(hand, discarded) - 1
  const suited = /^([mps])([1-9])$/.exec(discarded)
  let neighbors = 0
  let edgePenalty = 0
  if (suited) {
    const rank = Number(suited[2])
    neighbors += hand.includes(`${suited[1]}${rank - 1}` as TileType) ? 1 : 0
    neighbors += hand.includes(`${suited[1]}${rank + 1}` as TileType) ? 1 : 0
    edgePenalty = rank === 1 || rank === 9 ? 0 : 1
  }
  const honorPenalty = suited ? 0 : (earlyRound ? 12 : 3)
  const jokerPenalty = jokers.includes(discarded) ? 100 : discarded === 'white' ? 2 : 0
  return same * 4 + neighbors * 2 + edgePenalty + honorPenalty + jokerPenalty
}

/** 面对加杠：能抢必抢。 */
export function decideRobKong(_view: LotusRobKongView): LotusRobKongAction {
  return 'win'
}

/**
 * 弃牌启发式：优先打出孤张/字牌；精牌默认保留，只有手牌全是精牌时才兜底打出。
 * 评分越低越先打：同牌多 +4、有相邻靠张 +2、字牌 +6。
 */
interface DiscardOptions {
  exposedMelds?: number
  visibleTiles?: TileType[]
  publicTiles?: TileType[]
  upperLastDiscard?: TileType
  earlyRound?: boolean
  wallCount?: number
  /** 可选：番型潜力收益（点），血流策略注入；不传则行为与经典一致。 */
  patternBonus?: (hand: TileType[], melds: Meld[]) => number
  /** 可选：弃牌放炮成本（点），血流策略注入。 */
  safetyExposure?: (tile: TileType) => number
  /** 可选：现有副露（供 patternBonus 统计杠/碰）。 */
  melds?: Meld[]
}

export function chooseDiscardIndex(
  hand: TileType[],
  jokers: TileType[],
  random: () => number = Math.random,
  options: DiscardOptions = {},
): number {
  const extras: DiscardExtras = { melds: options.melds, patternBonus: options.patternBonus, safetyExposure: options.safetyExposure }
  const candidates = lotusDiscardCandidates(hand, jokers)
  const preliminary = candidates.map(({ tile, index }) => {
    const score = discardShapeScore(hand, tile) + random()
    const quality = options.exposedMelds == null
      ? null
      : discardQuality(
        hand.filter((_, candidateIndex) => candidateIndex !== index),
        tile,
        options.exposedMelds,
        jokers,
        options.visibleTiles ?? hand,
        options.earlyRound ?? false,
        options.publicTiles ?? [],
        options.upperLastDiscard,
        options.wallCount,
        false,
        extras,
      )
    return { index, score, quality }
  })
  preliminary.sort((a, b) => {
    if (a.quality && b.quality) return compareQuality(b.quality, a.quality) || a.score - b.score
    return a.score - b.score
  })
  if (options.wallCount != null && options.wallCount > 60) return preliminary[0]?.index ?? 0
  const shortlist = preliminary.slice(0, 3).map((item) => {
    const tile = hand[item.index]
    return {
      ...item,
      quality: options.exposedMelds == null ? null : discardQuality(
        hand.filter((_, candidateIndex) => candidateIndex !== item.index),
        tile,
        options.exposedMelds,
        jokers,
        options.visibleTiles ?? hand,
        options.earlyRound ?? false,
        options.publicTiles ?? [],
        options.upperLastDiscard,
        options.wallCount,
        true,
        extras,
      ),
    }
  })
  shortlist.sort((a, b) => {
    if (a.quality && b.quality) return compareQuality(b.quality, a.quality) || a.score - b.score
    return a.score - b.score
  })
  return shortlist[0]?.index ?? 0
}
