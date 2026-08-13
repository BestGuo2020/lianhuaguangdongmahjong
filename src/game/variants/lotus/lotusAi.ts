// 「莲花麻将」AI 决策层（纯函数）：看手牌/局面 → 给出动作命令，不改任何状态。
// 决策与执行分离，可独立单元测试。
import type { Meld, TileType } from '../../core/contracts/types'
import { removeMatches } from '../../core/rules/actions'
import { canPeng, concealedKongs, isWinningHand, matchingCount, waitingTiles, windKong, type ChiMeld, LOTUS_RULESET } from './lotusRules'
import type { RuleSet } from '../../core/rules/ruleset'

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
  ruleset?: RuleSet
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
}

export interface LotusRobKongView {
  hand: TileType[]
  exposedMelds: number
  tile: TileType
  from: number
  jokers: TileType[]
}

/** 回合决策：自摸胡 → 补杠 → 暗杠 → 乱风杠 → 弃牌。 */
export function decideTurn(view: LotusTurnView): LotusTurnDecision {
  if ((view.ruleset ?? LOTUS_RULESET).win.isWinningHand(view.hand, view.exposedMelds, { jokers: view.jokers })) return { kind: 'win' }

  const meldIndex = view.melds.findIndex(
    (meld) => meld.type === 'peng'
      && view.hand.includes(meld.tile),
  )
  if (meldIndex >= 0) return { kind: 'added-kong', meldIndex }

  const kong = (view.ruleset ?? LOTUS_RULESET).win.concealedKongs(view.hand, { jokers: view.jokers })[0]
  if (kong) return { kind: 'concealed-kong', tile: kong }

  if (windKong(view.hand, view.jokers)) return { kind: 'wind-kong' }

  return {
    kind: 'discard',
    handIndex: chooseDiscardIndex(view.hand, view.jokers, Math.random, {
      exposedMelds: view.exposedMelds,
      visibleTiles: view.visibleTiles,
      publicTiles: view.publicTiles,
      upperLastDiscard: view.upperLastDiscard,
      earlyRound: view.earlyRound,
    }),
  }
}

/** 面对弃牌：能杠必杠 → 能碰必碰 → 能吃则吃 → 过。 */
export function decideClaim(view: LotusClaimView): LotusClaimAction {
  // 杠后会从牌尾补牌，无法仅凭当前 13 张手牌准确判断补牌后的听口，
  // 因此继续保留杠的最高优先级；碰与吃则必须比较动作后的听牌质量。
  if (view.canGang) return { kind: 'gang' }

  const baseline = currentHandQuality(
    view.hand,
    view.exposedMelds,
    view.jokers,
    view.visibleTiles,
    view.publicTiles,
    view.upperLastDiscard,
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
    )
    if (discard) candidates.push({ action: { kind: 'chi', meld }, quality: discard.quality })
  }

  const best = candidates
    .filter((candidate) => compareQuality(candidate.quality, baseline) > 0)
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
  }
}

function currentHandQuality(
  hand: TileType[],
  exposedMelds: number,
  jokers: TileType[],
  visibleTiles: TileType[] = hand,
  _publicTiles: TileType[] = [],
  _upperLastDiscard?: TileType,
): DiscardQuality {
  const waits = waitingTiles(hand, exposedMelds, jokers)
  const specialScore = specialPatternScore(hand, exposedMelds, jokers)
  const attackScore = handQualityAttackScore(waits, waits.reduce((total, tile) => total + remainingCount(tile, visibleTiles), 0), specialScore)
  return {
    ready: waits.length > 0,
    waits,
    effectiveRemaining: waits.reduce((total, tile) => total + remainingCount(tile, visibleTiles), 0),
    specialScore,
    heuristic: 0,
    safetyScore: 0,
    netScore: attackScore,
  }
}

function compareQuality(a: DiscardQuality, b: DiscardQuality): number {
  if (a.ready !== b.ready) return a.ready ? 1 : -1
  if (a.netScore !== b.netScore) return a.netScore - b.netScore
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
) {
  if (!hand.length) return null
  const jokerSet = new Set(jokers)
  const hasNatural = hand.some((tile) => !jokerSet.has(tile))
  const candidates = hand
    .map((tile, index) => ({ tile, index }))
    .filter(({ tile }) => !hasNatural || !jokerSet.has(tile))
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
): DiscardQuality {
  const waits = waitingTiles(afterDiscard, exposedMelds, jokers)
  const effectiveRemaining = waits.reduce((total, tile) => total + remainingCount(tile, visibleTiles), 0)
  const specialScore = specialPatternScore(afterDiscard, exposedMelds, jokers)
  const safetyScore = publicSafetyScore(discarded, publicTiles, upperLastDiscard)
  const attackScore = handQualityAttackScore(waits, effectiveRemaining, specialScore)
  return {
    ready: waits.length > 0,
    waits,
    effectiveRemaining,
    specialScore,
    heuristic: discardHeuristic(afterDiscard, discarded, jokers, earlyRound),
    safetyScore,
    netScore: attackScore + safetyScore * 2,
  }
}

function handQualityAttackScore(waits: TileType[], effectiveRemaining: number, specialScore: number) {
  return (waits.length > 0 ? 80 : 0) + waits.length * 10 + effectiveRemaining * 2 + specialScore * 3
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

function specialPatternScore(hand: TileType[], exposedMelds: number, jokers: TileType[]) {
  if (exposedMelds > 0) return -20
  const lanDefects = shiSanLanDefects(hand, jokers)
  const lanScore = lanDefects <= 3 ? (4 - lanDefects) * 4 : 0
  return lanScore + pairPotential(hand, jokers) * 2
}

function shiSanLanDefects(hand: TileType[], jokers: TileType[]) {
  const jokerSet = new Set(jokers)
  const natural = hand.filter((tile) => !jokerSet.has(tile))
  let defects = natural.length - new Set(natural).size
  for (const suit of ['m', 'p', 's']) {
    const ranks = natural
      .filter((tile) => tile.startsWith(suit))
      .map((tile) => Number(tile[1]))
      .sort((a, b) => a - b)
    for (let index = 1; index < ranks.length; index += 1) {
      if (ranks[index] - ranks[index - 1] < 3) defects += 1
    }
  }
  return defects
}

function pairPotential(hand: TileType[], jokers: TileType[]) {
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
  return pairs + Math.min(singles, jokerCount)
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
  const jokerPenalty = jokers.includes(discarded) ? 100 : 0
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
}

export function chooseDiscardIndex(
  hand: TileType[],
  jokers: TileType[],
  random: () => number = Math.random,
  options: DiscardOptions = {},
): number {
  const jokerSet = new Set(jokers)
  const candidates = hand.some((tile) => !jokerSet.has(tile))
    ? hand.map((tile, index) => ({ tile, index })).filter(({ tile }) => !jokerSet.has(tile))
    : hand.map((tile, index) => ({ tile, index }))
  const scored = candidates.map(({ tile, index }) => {
    const same = matchingCount(hand, tile) - 1
    const suited = /^([mps])([1-9])$/.exec(tile)
    let neighbors = 0
    if (suited) {
      const rank = Number(suited[2])
      neighbors += hand.includes(`${suited[1]}${rank - 1}` as TileType) ? 1 : 0
      neighbors += hand.includes(`${suited[1]}${rank + 1}` as TileType) ? 1 : 0
    }
    const honor = suited ? 0 : 6
    const score = same * 4 + neighbors * 2 + honor + random()
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
      )
    return { index, score, quality }
  })
  scored.sort((a, b) => {
    if (a.quality && b.quality) return compareQuality(b.quality, a.quality) || a.score - b.score
    return a.score - b.score
  })
  return scored[0]?.index ?? 0
}
