// AI 玩家的纯决策层：只负责「看状态 → 给出动作命令」，不修改任何游戏状态、
// 不触发表现副作用，因此可以独立单元测试。动作的「执行」仍由 useGame 完成。
import { matchingCount } from '../rules/rules'
import type { GamePlayer, Meld, TileType } from '../contracts/types'
import { DEFAULT_RULESET, type RuleSet } from '../rules/ruleset'

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
  if (meldIndex >= 0 && !isTenpai(view.hand, view.exposedMelds, ruleset)) return { kind: 'added-kong', meldIndex }

  const kong = ruleset.win.concealedKongs(view.hand)[0]
  // 暗杠：已听牌时放弃（拆散成形手牌得不偿失）
  if (kong && !isTenpai(view.hand, view.exposedMelds, ruleset)) return { kind: 'concealed-kong', tile: kong }

  return { kind: 'discard', handIndex: chooseDiscardIndex(view.hand, random, view.exposedMelds, ruleset) }
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
function discardQuality(hand: TileType[], index: number, exposedMelds: number, ruleset: RuleSet): DiscardQuality {
  const after = hand.filter((_, candidateIndex) => candidateIndex !== index)
  // 打出后须为 3n+1（听牌态），否则听口必空（避免散手重计算）
  if (!canBeTenpai(after.length, exposedMelds)) return { ready: false, waitCount: 0, score: 0 }
  const waits = ruleset.win.waitingTiles(after, exposedMelds)
  if (!waits.length) return { ready: false, waitCount: 0, score: 0 }
  // 听口数 × 10 作为主要分，听口多则保留价值高；ready 标志用于优先级比较。
  return { ready: true, waitCount: waits.length, score: waits.length * 10 }
}

/**
 * 面对弃牌：能杠必杠；碰需评估碰后听口是否优于现状，不提升则 pass。
 * 广麻无点炮，防守价值低，主要看碰后是否更接近胡牌。
 */
export function decideClaim(view: AIClaimView): ClaimDecision {
  if (view.canGang) return 'gang'

  const ruleset = view.ruleset ?? DEFAULT_RULESET
  if (!view.tile) return 'peng'

  const exposedMelds = view.exposedMelds ?? 0
  const count = matchingCount(view.hand, view.tile)
  if (count < 2) return 'pass'

  // 现状：当前手牌（未碰）的听口。13 张（exposed=0）或 10 张（exposed=1）为听牌态。
  const baseline = currentTenpai(view.hand, exposedMelds, ruleset)

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
  const afterQuality = bestDiscardQuality(afterPeng, exposedMelds + 1, ruleset)
  return betterQuality(afterQuality, baseline) ? 'peng' : 'pass'
}

/** 当前手牌（未打出）的听口：直接 waitingTiles，手牌为听牌态（3n+1）时才计算。 */
function currentTenpai(hand: TileType[], exposedMelds: number, ruleset: RuleSet): DiscardQuality {
  const neededMelds = 4 - exposedMelds
  if (hand.length !== neededMelds * 3 + 1) return emptyQuality()
  const waits = ruleset.win.waitingTiles(hand, exposedMelds)
  if (!waits.length) return emptyQuality()
  return { ready: true, waitCount: waits.length, score: waits.length * 10 }
}

function bestDiscardQuality(hand: TileType[], exposedMelds: number, ruleset: RuleSet): DiscardQuality {
  if (!hand.length) return emptyQuality()
  let best: DiscardQuality | null = null
  for (let index = 0; index < hand.length; index += 1) {
    const quality = discardQuality(hand, index, exposedMelds, ruleset)
    if (best === null || betterQuality(quality, best)) best = quality
  }
  return best ?? emptyQuality()
}

function betterQuality(a: DiscardQuality, b: DiscardQuality): boolean {
  if (a.ready !== b.ready) return a.ready
  if (!a.ready) return false
  return a.score > b.score
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
): number {
  const scored = hand.map((tile, index) => {
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
    // 听口质量（waitingTiles 较重）：打出后为 3n+1 听牌态才计算，散手跳过。
    const structural = canBeTenpai(hand.length - 1, exposedMelds)
    const quality = structural ? discardQuality(hand, index, exposedMelds, ruleset) : { ready: false, waitCount: 0, score: 0 }
    const listenBonus = quality.ready ? 1000 + quality.score : 0
    return { index, score: base - listenBonus }
  })
  scored.sort((a, b) => a.score - b.score)
  return scored[0]?.index ?? 0
}

// 供 useGame 构造决策快照的辅助函数，避免各调用点重复拼装视图。
export function makeTurnView(player: GamePlayer, exposedMelds: number, kongBloom: boolean, ruleset?: RuleSet): AITurnView {
  return { hand: player.hand, melds: player.melds, exposedMelds, kongBloom, ruleset }
}
