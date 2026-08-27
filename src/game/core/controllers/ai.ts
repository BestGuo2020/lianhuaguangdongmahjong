// AI 玩家的纯决策层：只负责「看状态 → 给出动作命令」，不修改任何游戏状态、
// 不触发表现副作用，因此可以独立单元测试。动作的「执行」仍由 useGame 完成。
import { matchingCount } from '../rules/rules'
import type { GamePlayer, Meld, TileType } from '../contracts/types'
import { DEFAULT_RULESET, type RuleSet } from '../rules/ruleset'
import { compareHandProgress, evaluateHandProgress, type HandProgress } from '../../shared/ai/handProgress'

/** AI 回合内的动作命令 */
export type TurnDecision =
  | { kind: 'win' }
  | { kind: 'added-kong'; meldIndex: number }
  | { kind: 'concealed-kong'; tile: TileType }
  | { kind: 'discard'; handIndex: number }

/** 面对他家弃牌时的响应 */
export type ClaimDecision = 'gang' | 'peng' | 'pass'

/** 面对加杠时的抢杠响应 */
export type RobKongDecision = 'win' | 'pass'

/** 抢杠决策输入（供未来风险权衡扩展） */
export interface RobKongView {
  hand: TileType[]
  exposedMelds: number
  tile: TileType
  from: number
}

/** 回合决策输入：只暴露 AI 决策需要的只读信息 */
export interface AITurnView {
  hand: TileType[]
  melds: Meld[]
  /** 公开副露数（structuralMeldCount），用于胡牌判断 */
  exposedMelds: number
  /** 是否从牌墙尾补摸（杠后），用于杠上开花判断 */
  kongBloom: boolean
  playerIndex?: number
  visibleTiles?: TileType[]
  publicTiles?: TileType[]
  peers?: Array<{ discards: TileType[]; melds: Array<{ type: string; tile: TileType; tiles: TileType[] }> }>
  wallCount?: number
  ruleset?: RuleSet
}

/** 吃碰杠响应输入 */
export interface AIClaimView {
  hand: TileType[]
  /** 手牌中是否已凑齐 3 张可杠 */
  canGang: boolean
  /** 被弃出的牌（碰/杠对象） */
  tile?: TileType
  /** 弃牌来源座位 */
  from?: number
  /** 结构性副露数（碰后 +1，用于听口评估） */
  exposedMelds?: number
  playerIndex?: number
  visibleTiles?: TileType[]
  publicTiles?: TileType[]
  peers?: Array<{ discards: TileType[]; melds: Array<{ type: string; tile: TileType; tiles: TileType[] }> }>
  wallCount?: number
  ruleset?: RuleSet
}

/** 弃牌质量：打出某张后手牌的听口情况。 */
interface DiscardQuality {
  /** 打出后是否听牌 */
  ready: boolean
  /** 听口数量 */
  waitCount: number
  /** 离胡牌还差的有效张数（听口 × 剩余可用张，简化用听口数） */
  score: number
  progress?: HandProgress
  /** bestDiscardQuality 返回时记录对应舍牌，用于识别“碰后原样打回”。 */
  discardedTile?: TileType
  discardIndex?: number
}

function emptyQuality(): DiscardQuality {
  return { ready: false, waitCount: 0, score: -Infinity }
}
/**
 * 决策当前 AI 回合的动作，优先级与原 playAI 一致：
 * 自摸胡 → 补杠 → 暗杠 → 弃牌。杠前评估是否破坏听牌。
 * random 注入以便引擎建议（LLM 兜底）确定性化；默认 Math.random 维持既有行为。
 */
export function decideTurn(view: AITurnView, random: () => number = Math.random): TurnDecision {
  const ruleset = view.ruleset ?? DEFAULT_RULESET
  if (ruleset.win.isWinningHand(view.hand, view.exposedMelds)) return { kind: 'win' }

  const meldIndex = view.melds.findIndex(
    (meld) => meld.type === 'peng' && view.hand.includes(meld.tile),
  )
  // 补杠：已听牌时放弃（避免暴露第 4 张被抢杠 + 破坏手牌结构）
  if (meldIndex >= 0 && shouldTakeAddedKong(view, meldIndex, ruleset)) return { kind: 'added-kong', meldIndex }

  const kong = ruleset.win.concealedKongs(view.hand)[0]
  // 暗杠：已听牌时放弃（拆散成形手牌得不偿失）
  if (kong && shouldTakeConcealedKong(view, kong, ruleset)) return { kind: 'concealed-kong', tile: kong }

  return { kind: 'discard', handIndex: chooseDiscardIndex(view.hand, random, view.exposedMelds, ruleset, view) }
}

function progressOf(
  hand: TileType[], exposedMelds: number, ruleset: RuleSet, visibleTiles: TileType[] = hand,
): HandProgress {
  return evaluateHandProgress(hand, {
    exposedMelds,
    wildcardTiles: ['white'],
    visibleTiles,
    waitingTiles: (tiles, exposed) => ruleset.win.waitingTiles(tiles, exposed),
  })
}

function bestDiscardProgress(
  hand: TileType[], exposedMelds: number, ruleset: RuleSet, visibleTiles: TileType[] = hand,
) {
  let best: HandProgress | null = null
  const seen = new Set<TileType>()
  hand.forEach((tile, index) => {
    if (seen.has(tile)) return
    seen.add(tile)
    const progress = progressOf(hand.filter((_, candidateIndex) => candidateIndex !== index), exposedMelds, ruleset, visibleTiles)
    if (!best || compareHandProgress(progress, best) > 0) best = progress
  })
  return best
}

function opponentThreat(view: Pick<AITurnView, 'peers' | 'playerIndex' | 'wallCount'>) {
  const lateBonus = (view.wallCount ?? 99) <= 16 ? 2 : 0
  return (view.peers ?? []).reduce((sum, peer, index) => {
    if (index === (view.playerIndex ?? -1)) return sum
    return sum + peer.melds.length * 3 + lateBonus
  }, 0)
}

/** 补杠是广麻唯一会直接暴露抢杠胡目标的主动动作，残局/多副露时更保守。 */
function shouldTakeAddedKong(view: AITurnView, meldIndex: number, ruleset: RuleSet) {
  if (isTenpai(view.hand, view.exposedMelds, ruleset)) return false
  const tile = view.melds[meldIndex]?.tile
  if (!tile) return false
  const after = [...view.hand]
  const index = after.indexOf(tile)
  if (index >= 0) after.splice(index, 1)
  const current = bestDiscardProgress(view.hand, view.exposedMelds, ruleset, view.visibleTiles)
  const projected = progressOf(after, view.exposedMelds, ruleset, view.visibleTiles)
  const threat = opponentThreat(view)
  return threat < 10 && (!current || projected.shanten <= current.shanten + 1)
}

/** 暗杠按移除四张、增加一组副露后的结构投影，避免无条件拆掉更好的手牌。 */
function shouldTakeConcealedKong(view: AITurnView, tile: TileType, ruleset: RuleSet) {
  if (isTenpai(view.hand, view.exposedMelds, ruleset)) return false
  const after = view.hand.filter((item) => item !== tile)
  const current = bestDiscardProgress(view.hand, view.exposedMelds, ruleset, view.visibleTiles)
  const projected = progressOf(after, view.exposedMelds + 1, ruleset, view.visibleTiles)
  return !current || projected.shanten <= current.shanten + 1
}

/** 当前手牌是否已听牌（打出 1 张后为 3n+1 听牌态且听口非空）。散手直接返回 false 避免重计算。 */
function isTenpai(hand: TileType[], exposedMelds: number, ruleset: RuleSet): boolean {
  if (!canBeTenpai(hand.length - 1, exposedMelds)) return false
  for (let index = 0; index < hand.length; index += 1) {
    const after = hand.filter((_, candidateIndex) => candidateIndex !== index)
    if (ruleset.win.waitingTiles(after, exposedMelds).length > 0) return true
  }
  return false
}

/** 打出某张后的手牌是否可能听牌（长度 = 3n+1，补 1 张即胡）。 */
function canBeTenpai(afterLength: number, exposedMelds: number): boolean {
  const neededMelds = 4 - exposedMelds
  return afterLength === neededMelds * 3 + 1
}

/** 打出某张后的听口质量。 */
function discardQuality(
  hand: TileType[], index: number, exposedMelds: number, ruleset: RuleSet,
  visibleTiles: TileType[] = hand,
): DiscardQuality {
  const after = hand.filter((_, candidateIndex) => candidateIndex !== index)
  // 打出后须为 3n+1（听牌态），否则听口必空（避免散手重计算）
  if (!canBeTenpai(after.length, exposedMelds)) return { ready: false, waitCount: 0, score: 0 }
  const progress = progressOf(after, exposedMelds, ruleset, visibleTiles)
  const score = (6 - progress.shanten) * 1000 + progress.ukeire * 10 + progress.effectiveRemaining
  return {
    ready: progress.shanten === 0,
    waitCount: progress.waits.length,
    score,
    progress,
  }
}

/**
 * 面对弃牌：能杠必杠；碰需评估碰后听口是否优于现状，不提升则 pass。
 * 广麻无点炮，防守价值低，主要看碰后是否更接近胡牌。
 */
export function decideClaim(view: AIClaimView): ClaimDecision {
  const ruleset = view.ruleset ?? DEFAULT_RULESET
  if (view.canGang) {
    const baseline = currentTenpai(view.hand, view.exposedMelds ?? 0, ruleset, view.visibleTiles)
    const afterGang = removeMatchingTiles(view.hand, view.tile, 3)
    const projected = progressOf(afterGang, (view.exposedMelds ?? 0) + 1, ruleset, view.visibleTiles)
    // 杠有即时收益和尾牌补摸，仅在结构至少没有明显倒退时执行。
    if (!baseline.progress || projected.shanten <= baseline.progress.shanten + 1) return 'gang'
  }
  if (!view.tile) return 'peng'

  const exposedMelds = view.exposedMelds ?? 0
  const count = matchingCount(view.hand, view.tile)
  if (count < 2) return 'pass'

  // 现状：当前手牌（未碰）的听口。13 张（exposed=0）或 10 张（exposed=1）为听牌态。
  const baseline = currentTenpai(view.hand, exposedMelds, ruleset, view.visibleTiles)

  // 碰后手牌：移除两张；碰后必然要打一张，评估碰后最佳弃牌后的听口。
  const afterPeng: TileType[] = []
  let removed = 0
  for (const tile of view.hand) {
    if (tile === view.tile && removed < 2) {
      removed += 1
      continue
    }
    afterPeng.push(tile)
  }
  const afterQuality = bestDiscardQuality(afterPeng, exposedMelds + 1, ruleset, view.visibleTiles)
  if (!betterQuality(afterQuality, baseline)) return 'pass'
  // 手牌原有 3 张时，碰只拿走 2 张；若最佳后续动作是把第 3 张原样打回，
  // 大明杠得到同等最终结构，额外获得杠分和尾牌补摸，严格支配该碰法。
  if (view.canGang && afterQuality.discardedTile === view.tile) return 'gang'
  return 'peng'
}

function removeMatchingTiles(hand: TileType[], tile: TileType | undefined, amount: number) {
  if (!tile) return [...hand]
  let removed = 0
  return hand.filter((item) => item !== tile || removed++ >= amount)
}

/** 当前手牌（未打出）的听口：直接 waitingTiles，手牌为听牌态（3n+1）时才计算。 */
function currentTenpai(
  hand: TileType[], exposedMelds: number, ruleset: RuleSet, visibleTiles: TileType[] = hand,
): DiscardQuality {
  const neededMelds = 4 - exposedMelds
  if (hand.length !== neededMelds * 3 + 1) return emptyQuality()
  const progress = progressOf(hand, exposedMelds, ruleset, visibleTiles)
  return {
    ready: progress.shanten === 0,
    waitCount: progress.waits.length,
    score: (6 - progress.shanten) * 1000 + progress.ukeire * 10 + progress.effectiveRemaining,
    progress,
  }
}

function bestDiscardQuality(
  hand: TileType[], exposedMelds: number, ruleset: RuleSet, visibleTiles: TileType[] = hand,
): DiscardQuality {
  if (!hand.length) return emptyQuality()
  let best: DiscardQuality | null = null
  for (let index = 0; index < hand.length; index += 1) {
    const quality = {
      ...discardQuality(hand, index, exposedMelds, ruleset, visibleTiles),
      discardedTile: hand[index],
      discardIndex: index,
    }
    if (best === null || betterQuality(quality, best)) best = quality
  }
  return best ?? emptyQuality()
}

function betterQuality(a: DiscardQuality, b: DiscardQuality): boolean {
  if (a.ready !== b.ready) return a.ready
  // 副露只有在至少一方已听牌时才允许改变结构；散手阶段避免为一阶向听估值过早开碰。
  if (a.ready && a.progress && b.progress) {
    const compared = compareHandProgress(a.progress, b.progress)
    if (compared !== 0) return compared > 0
  }
  if (!a.ready) return false
  return a.score > b.score
}

export interface DiscardStrategyContext {
  playerIndex?: number
  visibleTiles?: TileType[]
  publicTiles?: TileType[]
  peers?: Array<{ discards: TileType[]; melds: Array<{ type: string; tile: TileType; tiles: TileType[] }> }>
  wallCount?: number
}

function feedRisk(tile: TileType, context: DiscardStrategyContext = {}) {
  const suited = /^([mps])([1-9])$/.exec(tile)
  let risk = 0
  for (const [index, peer] of (context.peers ?? []).entries()) {
    if (index === context.playerIndex) continue
    const melds = peer.melds.filter((meld) => meld.type !== 'flower')
    if (!melds.length) continue
    risk += melds.length * 2
    if (suited) {
      const sameSuit = melds.filter((meld) => meld.tile[0] === suited[1]).length
      const offSuitDiscards = peer.discards.filter((discard) => /^[mps]/.test(discard) && discard[0] !== suited[1]).length
      risk += sameSuit * 3 + Math.min(3, offSuitDiscards)
    }
    if (peer.discards.includes(tile)) risk = Math.max(0, risk - 2)
  }
  if ((context.wallCount ?? 99) <= 16) risk *= 1.5
  return risk
}

/** 面对加杠：当前 AI 能抢必抢；未来可按听牌风险权衡后返回 'pass'。 */
export function decideRobKong(_view: RobKongView): RobKongDecision {
  return 'win'
}

/**
 * 弃牌启发式：优先打掉「孤张」——同牌少、无相邻靠张的牌；
 * 白板（癞子）加罚分保手。random 注入以便测试确定化。
 * 有 exposedMelds 时叠加听口质量：打出后听口越多越后打，已听牌优先保留。
 */
export function chooseDiscardIndex(
  hand: TileType[],
  random: () => number = Math.random,
  exposedMelds = 0,
  ruleset: RuleSet = DEFAULT_RULESET,
  context: DiscardStrategyContext = {},
): number {
  const preliminary = hand.map((tile, index) => {
    const same = matchingCount(hand, tile) - 1
    const suitMatch = /^([mps])([1-9])$/.exec(tile)
    let neighbors = 0
    if (suitMatch) {
      const number = Number(suitMatch[2])
      neighbors += hand.includes(`${suitMatch[1]}${number - 1}` as TileType) ? 1 : 0
      neighbors += hand.includes(`${suitMatch[1]}${number + 1}` as TileType) ? 1 : 0
    }
    const penalty = tile === 'white' ? 10 : 0
    // 基础分：越低越先打（孤张优先）
    const base = same * 4 + neighbors * 2 + penalty + random()
    const risk = feedRisk(tile, context)
    return { index, tile, preliminaryScore: base + risk }
  })
  // 先用低成本结构分筛出最可能的 2 张，再做精确向听/进张；避免每回合 14×DFS。
  const shortlist = new Set<number>()
  const shortlistedTiles = new Set<TileType>()
  for (const item of preliminary.slice().sort((a, b) => a.preliminaryScore - b.preliminaryScore)) {
    if (shortlistedTiles.has(item.tile)) continue
    shortlistedTiles.add(item.tile)
    shortlist.add(item.index)
    if (shortlist.size >= 2) break
  }
  const structural = canBeTenpai(hand.length - 1, exposedMelds)
  const shouldEvaluateProgress = context.wallCount == null || context.wallCount <= 60
  const scored = preliminary.map((item) => {
    if (!shortlist.has(item.index) || !structural || !shouldEvaluateProgress) {
      return { index: item.index, score: item.preliminaryScore }
    }
    const quality = discardQuality(hand, item.index, exposedMelds, ruleset, context.visibleTiles ?? hand)
    const progressScore = quality.progress
      ? (6 - quality.progress.shanten) * 10_000 + quality.progress.ukeire * 100 + quality.progress.effectiveRemaining * 10
      : 0
    return { index: item.index, score: item.preliminaryScore - progressScore }
  })
  scored.sort((a, b) => a.score - b.score)
  return scored[0]?.index ?? 0
}

// 供 useGame 构造决策快照的辅助函数，避免各调用点重复拼装视图。
export function makeTurnView(player: GamePlayer, exposedMelds: number, kongBloom: boolean, ruleset?: RuleSet): AITurnView {
  return { hand: player.hand, melds: player.melds, exposedMelds, kongBloom, ruleset }
}
