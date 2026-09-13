// 真·大牌路线（v4）：把"要不要做十三幺/九莲"的决定从模型手里拿回引擎。
//
// 背景（实测）：在同一手"13 种幺九 + 一张闲牌"的局面里，deepseek-v4-pro 4/4 选择放弃小胡去做十三幺，
// 而 glm-5.3 / glm-5.3-flash / gpt-5.6-luna / gpt-5.6-sol 全部 4/4 选择直接胡——**换更高档的模型也不会做大牌**，
// 越稳的模型越贴引擎期望值。所以"大牌路线"不能靠模型自觉，要靠**候选层收窄**：引擎判定路线已成立时，
// 只把"不掉路线的牌"交给模型，模型只决定"怎么打"，不决定"做不做"。
//
// 约束：本模块只被 LLM 候选构造使用（`buildBloodFlowDecisionInput`），**不改引擎/普通 AI 的决策**。
import type { Meld, TileType } from '../../../core/contracts/types'

export type BigHandRouteId =
  | 'thirteenOrphans' | 'nineGates'
  /** 2026-09-14 追加：推广到普通 AI 座的三条"半大牌"路线（清一色 8 番 / 混一色 4 番 / 碰碰胡 4 番）。 */
  | 'pureSuit' | 'mixedSuit' | 'allTriplets'

/** 副露策略：门清路线一条都不许；碰碰胡只要碰/杠；花色路线允许同色（混一色还含字牌）的吃碰杠。 */
export interface BigHandRouteClaims {
  readonly chi: boolean
  readonly peng: boolean
  readonly gang: boolean
  /** 副露牌张的过滤口径。 */
  readonly tile: 'none' | 'any' | 'mainSuit' | 'mainSuitOrHonor'
}

export interface BigHandRoute {
  readonly id: BigHandRouteId
  readonly label: string
  /** 完成时的番型权重（十六倍级）。 */
  readonly weight: number
  /** 0..1 接近度。 */
  readonly progress: number
  /** 还缺的牌（给 prompt 用）。 */
  readonly need: readonly string[]
  /** 当前持有、属于该路线的牌（用于判定"打这张是否掉路线"）。 */
  readonly keepers: readonly TileType[]
  /**
   * 是否**能按自然牌（硬胡）完成**：false = 必须靠精牌顶替，完成时是软胡（无硬胡 ×2）。
   * 实战实测：10 局里做成的 6 次十三幺有 5 次靠精顶替 ⇒ 赔付口径必须区分硬/软，否则会"为 160 点放弃 80 点小胡"。
   */
  readonly naturalOnly: boolean
  /** 该路线允许的副露方式（2026-09-14 追加：路线感知，不再是"一律撤掉副露"）。 */
  readonly claims: BigHandRouteClaims
  /** 花色路线的守门花色（用于副露过滤与"该打掉的牌"提示）。 */
  readonly mainSuit?: 'm' | 'p' | 's'
}

const NO_CLAIMS: BigHandRouteClaims = Object.freeze({ chi: false, peng: false, gang: false, tile: 'none' })
const flushClaims = (tile: BigHandRouteClaims['tile']): BigHandRouteClaims =>
  Object.freeze({ chi: true, peng: true, gang: true, tile })

export interface BigHandRouteConfig {
  /** 'off' = 关闭；'llm' = 只对 LLM 候选生效；'bot' = 只对本地 AI 座生效；'all' = 两边都生效。 */
  readonly mode: 'off' | 'llm' | 'bot' | 'all'
  /** 启用的路线（默认只有 v4 的十三幺/九莲，保持现有行为；推广实验再打开其余三条）。 */
  readonly enabled: readonly BigHandRouteId[]
  /** 十三幺：手上已有多少种幺九字牌才算路线成立（13 种为完成）。 */
  readonly minOrphanKinds: number
  /** 九莲宝灯：某一门数牌需要凑齐多少种（9 = 凑齐 1-9）。 */
  readonly minSuitRanks: number
  /** 九莲宝灯：该门牌张数下限（避免 1-9 各一张就冲）。 */
  readonly minSuitTiles: number
  /** 清一色：同花色自然张数下限。 */
  readonly pureSuitMinTiles: number
  /** 清一色：异色 + 字牌自然张数上限（超过就不算"在路上"）。 */
  readonly pureSuitMaxForeign: number
  /** 混一色：同花色自然张数下限。 */
  readonly mixedSuitMinTiles: number
  /** 混一色：另一门数牌的自然张数上限（字牌不算 foreign）。 */
  readonly mixedSuitMaxForeign: number
  /** 碰碰胡：对/刻单位下限（刻子算 1、对子算 1、精算 1）。 */
  readonly allTripletsMinUnits: number
  /** 承诺门槛：路线完成收益 ≥ 立即胡收益 × 该倍数时，不再给"胡"候选。 */
  readonly declineWinRatio: number
  /**
   * 时机门槛①：牌墙还剩这么多张以上才承诺（摸不到就等于空承诺；实测 10 张门槛时 22% 的决策都在承诺模式，代价过大）。
   */
  readonly minWallForCommit: number
  /** 时机门槛②：落后这么多分时也允许承诺（需要大牌翻盘）。 */
  readonly minDeficitForCommit: number
  /**
   * 精牌 ≥ `jokerReliefCount` 张时，牌墙门槛放宽到该值（精牌多 ⇒ 完成率高 ⇒ 可以更早承诺）。
   */
  readonly minWallForCommitWithJokers: number
  /** 触发"精牌放宽"的持有精牌张数。 */
  readonly jokerReliefCount: number
}

export const BLOOD_FLOW_BIG_HAND_ROUTE: Readonly<BigHandRouteConfig> = Object.freeze({
  mode: 'off',
  // 默认只启用 v4 的两条门清路线（保持既有 LLM 行为）；清一色/混一色/碰碰胡见 WIDE 变体。
  enabled: Object.freeze(['thirteenOrphans', 'nineGates'] as const),
  // 收紧后：十三幺要 12 种幺九（13 种为完成）、九莲要该门 12 张以上且 1-9 齐
  // 注意：这两条都是"含精牌折算后"的要求，持有 J 张可顶替的精牌时自然牌要求降为 12-J / 12-J 张
  minOrphanKinds: 12,
  minSuitRanks: 9,
  minSuitTiles: 12,
  // 清一色/混一色：同花色 ≥10 张、异色（混一色的字牌不计）≤2 / ≤1 张才算在路上
  pureSuitMinTiles: 10,
  pureSuitMaxForeign: 2,
  mixedSuitMinTiles: 10,
  mixedSuitMaxForeign: 1,
  // 碰碰胡：对/刻单位 ≥4（4 刻 + 1 将需要 5 单位）
  allTripletsMinUnits: 4,
  declineWinRatio: 2,
  minWallForCommit: 20,
  minDeficitForCommit: 300,
  minWallForCommitWithJokers: 15,
  jokerReliefCount: 2,
})

/**
 * 推广变体（2026-09-14，用户定案："把 v4 路线收窄推广到普通 AI 座"）：
 * 在十三幺/九莲之外启用清一色、混一色、碰碰胡三条线，并应用到**普通 AI 座**（mode='bot'）。
 * 与 v4 的差别只有"启用哪些路线 + 谁生效"；门槛、承诺比例、时机门槛全部沿用同一份。
 */
export const BLOOD_FLOW_BIG_HAND_ROUTE_WIDE: Readonly<BigHandRouteConfig> = Object.freeze({
  ...BLOOD_FLOW_BIG_HAND_ROUTE,
  mode: 'bot' as const,
  enabled: Object.freeze(['thirteenOrphans', 'nineGates', 'pureSuit', 'mixedSuit', 'allTriplets'] as const),
})

/** 收紧前的松门槛（仅用于 A/B 对照）。 */
export const BLOOD_FLOW_BIG_HAND_ROUTE_LOOSE: Readonly<BigHandRouteConfig> = Object.freeze({
  ...BLOOD_FLOW_BIG_HAND_ROUTE, minOrphanKinds: 10, minSuitTiles: 10,
})

/** 十三幺需要的 13 种牌。 */
export const THIRTEEN_ORPHANS: readonly TileType[] = [
  'm1', 'm9', 'p1', 'p9', 's1', 's9', 'east', 'south', 'west', 'north', 'red', 'green', 'white',
]

const NUMERIC = /^([mps])([1-9])$/
const ORPHAN_SET = new Set(THIRTEEN_ORPHANS)

/**
 * 判定当前手牌是否已经"成立"某条大牌路线。只在**硬条件已满足**时才返回（低风险：手牌本身已经在路上）。
 * 只读本家暗手与副露；不考虑对手信息。
 */
export function detectBigHandRoute(
  hand: readonly TileType[],
  melds: readonly Readonly<Meld>[],
  jokers: readonly TileType[],
  config: BigHandRouteConfig = BLOOD_FLOW_BIG_HAND_ROUTE,
): BigHandRoute | null {
  if (config.mode === 'off') return null
  const candidates: BigHandRoute[] = []
  const wildcards = new Set([...jokers, 'white'])
  const jokerCount = hand.filter(tile => wildcards.has(tile)).length

  // 十三幺：门清（无副露）+ 已持足够多种幺九字牌。
  if (melds.length === 0) {
    const kinds = THIRTEEN_ORPHANS.filter(tile => hand.includes(tile)).length
    const kindsAfterJokers = Math.min(13, kinds + jokerCount)
    if (kindsAfterJokers >= config.minOrphanKinds) {
      candidates.push({
        id: 'thirteenOrphans', label: '十三幺', weight: 16,
        progress: kindsAfterJokers / 13,
        need: THIRTEEN_ORPHANS.filter(tile => !hand.includes(tile)),
        keepers: hand.filter(tile => ORPHAN_SET.has(tile)),
        // 13 种都在手上 → 可以自然完成（硬胡）；否则必须靠精顶替（软胡）
        naturalOnly: kinds >= 13,
        claims: NO_CLAIMS,
      })
    }
  }

  // 九莲宝灯 / 清一色：门清 + 某一门数牌凑齐 1-9（字牌与别门牌都是"该打掉的"，不影响判定）。
  if (melds.length === 0) {
    for (const suit of ['m', 'p', 's'] as const) {
      const tiles = hand.filter(tile => tile.startsWith(suit))
      const naturalTiles = tiles.filter(tile => !wildcards.has(tile))
      const ranks = new Set(naturalTiles.map(tile => tile[1]))
      const wildcardExtra = Math.min(9 - ranks.size, jokerCount)
      if (ranks.size + wildcardExtra >= config.minSuitRanks && tiles.length + jokerCount >= config.minSuitTiles) {
        const missing = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
          .filter(rank => !ranks.has(rank)).map(rank => `${suit}${rank}`)
        candidates.push({
          id: 'nineGates', label: '九莲宝灯', weight: 16,
          progress: Math.min(1, (ranks.size + wildcardExtra) / 9),
          need: missing as unknown as readonly string[],
          keepers: tiles,
          // 1-9 全自然 + 本门自然张数 ≥13 → 可自然完成（硬胡）
          naturalOnly: ranks.size >= 9 && naturalTiles.length >= 13,
          claims: NO_CLAIMS,
        })
      }
    }
  }

  // ── 2026-09-14 追加：三条"半大牌"路线（清一色 / 混一色 / 碰碰胡）──
  // 与十三幺/九莲的关键差别：**它们允许副露**（同色吃碰杠、碰碰胡必须碰），所以不能沿用"一律撤副露"。
  const enabled = new Set(config.enabled)
  const meldTiles = melds.flatMap(meld => [...meld.tiles])
  const naturalHand = hand.filter(tile => !wildcards.has(tile))
  const naturalAll = [...naturalHand, ...meldTiles.filter(tile => !wildcards.has(tile))]
  const effective = hand.length + 3 * melds.length
  const hasChiMeld = melds.some(meld => meld.type === 'chi')
  const naturalOnly = jokerCount === 0

  if (enabled.has('pureSuit') || enabled.has('mixedSuit')) {
    for (const suit of ['m', 'p', 's'] as const) {
      const suitedAll = naturalAll.filter(isSuitedTile)
      const mainTiles = suitedAll.filter(tile => tile.startsWith(suit)).length + jokerCount
      const foreignSuits = suitedAll.filter(tile => !tile.startsWith(suit)).length
      const honorsAll = naturalAll.filter(tile => !isSuitedTile(tile)).length
      // 清一色的副露必须同色（含精牌）；混一色还允许字牌副露。
      const suitMeldOk = meldTiles.every(tile => wildcards.has(tile) || tile.startsWith(suit))
      const honorMeldOk = meldTiles.every(tile => wildcards.has(tile) || tile.startsWith(suit) || !isSuitedTile(tile))
      if (enabled.has('pureSuit') && suitMeldOk && mainTiles >= config.pureSuitMinTiles
        && foreignSuits + honorsAll <= config.pureSuitMaxForeign) {
        candidates.push({
          id: 'pureSuit', label: '清一色', weight: 8,
          progress: Math.min(1, mainTiles / Math.max(1, effective)),
          need: [`${suit} 门任意牌`] as unknown as readonly string[],
          keepers: hand.filter(tile => tile.startsWith(suit)),
          naturalOnly,
          claims: flushClaims('mainSuit'),
          mainSuit: suit,
        })
      }
      if (enabled.has('mixedSuit') && honorMeldOk && mainTiles >= config.mixedSuitMinTiles
        && foreignSuits <= config.mixedSuitMaxForeign) {
        candidates.push({
          id: 'mixedSuit', label: '混一色', weight: 4,
          progress: Math.min(1, (mainTiles + honorsAll) / Math.max(1, effective)),
          need: [`${suit} 门或字牌`] as unknown as readonly string[],
          keepers: hand.filter(tile => tile.startsWith(suit) || !isSuitedTile(tile)),
          naturalOnly,
          claims: flushClaims('mainSuitOrHonor'),
          mainSuit: suit,
        })
      }
    }
  }

  if (enabled.has('allTriplets') && !hasChiMeld) {
    const counts = new Map<TileType, number>()
    naturalHand.forEach(tile => counts.set(tile, (counts.get(tile) ?? 0) + 1))
    let realTriplets = melds.filter(meld => meld.type !== 'chi' && !meld.windKong).length
    let pairUnits = 0
    counts.forEach(count => {
      realTriplets += Math.floor(count / 3)
      if (count % 3 === 2) pairUnits += 1
    })
    // 精牌能把对子顶成刻子，但最多顶到"够 2 刻"为止；"一堆对子"不算碰碰胡路线（那更像七对）。
    const effectiveTriplets = realTriplets + Math.min(jokerCount, pairUnits)
    const unitsWithJokers = realTriplets + pairUnits + jokerCount
    if (effectiveTriplets >= 2 && unitsWithJokers >= config.allTripletsMinUnits) {
      candidates.push({
        id: 'allTriplets', label: '碰碰胡', weight: 4,
        progress: Math.min(1, unitsWithJokers / 5),
        need: ['刻子/杠（不要顺子）'] as unknown as readonly string[],
        keepers: hand.filter(tile => (counts.get(tile) ?? 0) >= 2),
        naturalOnly,
        // 碰碰胡靠碰/杠推进，但**不能吃**（吃出顺子就不是碰碰胡了）。
        claims: Object.freeze({ chi: false, peng: true, gang: true, tile: 'any' as const }),
      })
    }
  }

  if (!candidates.length) return null
  // 多条同时成立时取"番值 × 接近度²"最高的那条（与潜力模型同口径）：
  // 只比 progress 会让"11 张一门 + 2 字牌"这种局面选到低番的混一色（它 progress 更高），
  // 而清一色（8 番）才是这手牌真正的上限。
  return candidates.sort((a, b) => b.weight * b.progress ** 2 - a.weight * a.progress ** 2)[0]
}

/** 数牌（两字符且首字为花色）——注意 startsWith('s') 会误把 'south' 当数牌。 */
function isSuitedTile(tile: TileType): boolean {
  return NUMERIC.test(tile)
}

/** 打掉某张之后路线是否还在（接近度不下降，且仍是同一条路线）。 */
export function routeKeepsProgress(
  after: readonly TileType[],
  melds: readonly Readonly<Meld>[],
  jokers: readonly TileType[],
  route: BigHandRoute,
  config: BigHandRouteConfig = BLOOD_FLOW_BIG_HAND_ROUTE,
): boolean {
  const next = detectBigHandRoute(after, melds, jokers, config)
  if (!next || next.id !== route.id) return false
  return next.progress + 1e-9 >= route.progress
}

/**
 * 路线完成时的估算收益（点）：**软胡（靠精顶替）只有硬胡的一半**（无 ×2）。
 * 实测：做成的十三幺 5/6 靠精顶替，所以赔付口径必须区分，否则会出现"为 160 点放弃 80 点小胡"的不划算承诺。
 */
export function routePayoff(route: BigHandRoute, basePoints: number, hardWinMultiplier = 2): number {
  return basePoints * route.weight * (route.naturalOnly ? hardWinMultiplier : 1)
}

export interface BigHandRouteNarrowing {
  readonly route: BigHandRoute | null
  readonly actions: readonly unknown[]
  /** 是否真的收窄了（false = 未启用/无路线/收窄后为空的安全阀）。 */
  readonly collapsed: boolean
}

/**
 * 把候选收窄成"不掉路线"的那部分（**唯一实现**，LLM 候选构造、整场度量与本地 AI 座共用）。
 *
 * - 弃牌：只留打出去后路线接近度不下降的；
 * - 胡：路线完成收益 ≥ 立即胡收益 × declineWinRatio 时撤掉（承诺路线），否则保留（**已经能胡成的大牌不会被放弃**）；
 * - 吃碰杠（2026-09-14 起**路线感知**）：按 `route.claims` 判定——门清路线（十三幺/九莲）一律撤掉，
 *   碰碰胡留碰/杠、撤吃，清一色/混一色只留"守门花色（混一色还含字牌）"的吃碰杠；
 * - 过保留。
 *
 * 收窄后为空时返回原动作集（安全阀），避免"无牌可打"。
 */
export function narrowActionsToRoute<T extends { kind: string; index?: number; tiles?: readonly TileType[] }>(
  hand: readonly TileType[],
  melds: readonly Readonly<Meld>[],
  jokers: readonly TileType[],
  actions: readonly T[],
  options: {
    config?: BigHandRouteConfig
    basePoints: number
    /** 立即胡的赔付（点炮/自摸口径由调用方给出）。 */
    immediateWinPayment?: number
    /** 牌墙剩余（用于时机门槛）。 */
    wallCount?: number
    /** 落后分数（本方分数 - 场上最高分，取正数；用于时机门槛）。 */
    scoreDeficit?: number
    /** 本窗口被弃出的那张牌（判定吃碰杠是否保路线时用）。 */
    claimedTile?: TileType
  },
): { route: BigHandRoute | null; actions: readonly T[]; collapsed: boolean } {
  const config = options.config ?? BLOOD_FLOW_BIG_HAND_ROUTE
  const wildcards = new Set<TileType>([...jokers, 'white'])
  const route = detectBigHandRoute(hand, melds, jokers, config)
  if (!route) return { route: null, actions, collapsed: false }
  // 时机门槛：牌墙还有余地，或落后到需要大牌翻盘，才值得承诺；持有精牌多时牌墙要求放宽。
  const heldJokers = hand.filter(tile => wildcards.has(tile)).length
  const wallFloor = heldJokers >= config.jokerReliefCount ? config.minWallForCommitWithJokers : config.minWallForCommit
  const wallOk = options.wallCount === undefined || options.wallCount >= wallFloor
  const deficitOk = (options.scoreDeficit ?? 0) >= config.minDeficitForCommit
  if (!wallOk && !deficitOk) return { route, actions, collapsed: false }
  const chaseWorth = routePayoff(route, options.basePoints) >= (options.immediateWinPayment ?? 0) * config.declineWinRatio
  const kept = actions.filter(action => {
    if (action.kind === 'discard' && typeof action.index === 'number') {
      const after = hand.filter((_, index) => index !== action.index)
      return routeKeepsProgress(after, melds, jokers, route, config)
    }
    if (action.kind === 'win') return !chaseWorth
    if (action.kind === 'pass') return true
    return claimKeepsRoute(route, action, options.claimedTile, wildcards)
  })
  if (!kept.length) return { route, actions, collapsed: false }
  return { route, actions: kept, collapsed: true }
}

/** 吃碰杠是否保路线（路线感知：门清路线一律否；碰碰胡只认碰/杠；花色路线只认守门花色/字牌）。 */
export function claimKeepsRoute(
  route: BigHandRoute,
  action: { kind: string; tiles?: readonly TileType[] },
  claimedTile: TileType | undefined,
  wildcards: ReadonlySet<TileType>,
): boolean {
  const claims = route.claims
  if (action.kind === 'chi' && !claims.chi) return false
  if (action.kind === 'peng' && !claims.peng) return false
  const kongKinds = ['gang', 'added-kong', 'concealed-kong', 'wind-kong']
  if (kongKinds.includes(action.kind) && !claims.gang) return false
  if (claims.tile === 'none') return false
  if (claims.tile === 'any') return true
  const tiles = action.tiles ?? (claimedTile ? [claimedTile] : [])
  if (!tiles.length) return true
  return tiles.every(tile => {
    if (wildcards.has(tile)) return true
    if (claims.tile === 'mainSuitOrHonor') return !isSuitedTile(tile) || tile.startsWith(route.mainSuit ?? '')
    return isSuitedTile(tile) && tile.startsWith(route.mainSuit ?? '')
  })
}
