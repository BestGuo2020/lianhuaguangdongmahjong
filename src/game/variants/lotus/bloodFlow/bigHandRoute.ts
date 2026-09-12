// 真·大牌路线（v4）：把"要不要做十三幺/九莲"的决定从模型手里拿回引擎。
//
// 背景（实测）：在同一手"13 种幺九 + 一张闲牌"的局面里，deepseek-v4-pro 4/4 选择放弃小胡去做十三幺，
// 而 glm-5.3 / glm-5.3-flash / gpt-5.6-luna / gpt-5.6-sol 全部 4/4 选择直接胡——**换更高档的模型也不会做大牌**，
// 越稳的模型越贴引擎期望值。所以"大牌路线"不能靠模型自觉，要靠**候选层收窄**：引擎判定路线已成立时，
// 只把"不掉路线的牌"交给模型，模型只决定"怎么打"，不决定"做不做"。
//
// 约束：本模块只被 LLM 候选构造使用（`buildBloodFlowDecisionInput`），**不改引擎/普通 AI 的决策**。
import type { Meld, TileType } from '../../../core/contracts/types'

export type BigHandRouteId = 'thirteenOrphans' | 'nineGates'

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
}

export interface BigHandRouteConfig {
  /** 'off' = 关闭（候选不收敛，行为与现状一致）；'llm' = 只对 LLM 候选生效。 */
  readonly mode: 'off' | 'llm'
  /** 十三幺：手上已有多少种幺九字牌才算路线成立（13 种为完成）。 */
  readonly minOrphanKinds: number
  /** 九莲宝灯：某一门数牌需要凑齐多少种（9 = 凑齐 1-9）。 */
  readonly minSuitRanks: number
  /** 九莲宝灯：该门牌张数下限（避免 1-9 各一张就冲）。 */
  readonly minSuitTiles: number
  /** 承诺门槛：路线完成收益 ≥ 立即胡收益 × 该倍数时，不再给"胡"候选。 */
  readonly declineWinRatio: number
  /**
   * 时机门槛①：牌墙还剩这么多张以上才承诺（摸不到就等于空承诺；实测 10 张门槛时 22% 的决策都在承诺模式，代价过大）。
   */
  readonly minWallForCommit: number
  /** 时机门槛②：落后这么多分时也允许承诺（需要大牌翻盘）。 */
  readonly minDeficitForCommit: number
}

export const BLOOD_FLOW_BIG_HAND_ROUTE: Readonly<BigHandRouteConfig> = Object.freeze({
  mode: 'off',
  // 收紧后：十三幺要 12 种幺九（13 种为完成）、九莲要该门 12 张以上且 1-9 齐
  minOrphanKinds: 12,
  minSuitRanks: 9,
  minSuitTiles: 12,
  declineWinRatio: 2,
  minWallForCommit: 20,
  minDeficitForCommit: 300,
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
      })
    }
  }

  // 九莲宝灯 / 清一色：门清 + 某一门数牌凑齐 1-9（字牌与别门牌都是"该打掉的"，不影响判定）。
  if (melds.length === 0) {
    for (const suit of ['m', 'p', 's'] as const) {
      const tiles = hand.filter(tile => tile.startsWith(suit))
      const ranks = new Set(tiles.map(tile => tile[1]))
      const wildcardExtra = Math.min(9 - ranks.size, jokerCount)
      if (ranks.size + wildcardExtra >= config.minSuitRanks && tiles.length + jokerCount >= config.minSuitTiles) {
        const missing = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
          .filter(rank => !ranks.has(rank)).map(rank => `${suit}${rank}`)
        candidates.push({
          id: 'nineGates', label: '九莲宝灯', weight: 16,
          progress: Math.min(1, (ranks.size + wildcardExtra) / 9),
          need: missing as unknown as readonly string[],
          keepers: tiles,
        })
      }
    }
  }

  if (!candidates.length) return null
  // 两条都成立时取"更接近完成"的那条（同权重下比 progress）。
  return candidates.sort((a, b) => b.progress - a.progress)[0]
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

/** 路线完成时的估算收益（硬胡 × 基础分），用于和"立即胡"比较。 */
export function routePayoff(route: BigHandRoute, basePoints: number, hardWinMultiplier = 2): number {
  return basePoints * route.weight * hardWinMultiplier
}

export interface BigHandRouteNarrowing {
  readonly route: BigHandRoute | null
  readonly actions: readonly unknown[]
  /** 是否真的收窄了（false = 未启用/无路线/收窄后为空的安全阀）。 */
  readonly collapsed: boolean
}

/**
 * 把候选收窄成"不掉路线"的那部分（**唯一实现**，LLM 候选构造与整场度量共用）。
 *
 * - 弃牌：只留打出去后路线接近度不下降的；
 * - 胡：路线完成收益 ≥ 立即胡收益 × declineWinRatio 时撤掉（承诺路线），否则保留；
 * - 其他（吃碰杠等）：一律撤掉（会破坏门清路线）；过保留。
 *
 * 收窄后为空时返回原动作集（安全阀），避免"无牌可打"。
 */
export function narrowActionsToRoute<T extends { kind: string; index?: number }>(
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
  },
): { route: BigHandRoute | null; actions: readonly T[]; collapsed: boolean } {
  const config = options.config ?? BLOOD_FLOW_BIG_HAND_ROUTE
  const route = detectBigHandRoute(hand, melds, jokers, config)
  if (!route) return { route: null, actions, collapsed: false }
  // 时机门槛：牌墙还有余地，或落后到需要大牌翻盘，才值得承诺。
  const wallOk = options.wallCount === undefined || options.wallCount >= config.minWallForCommit
  const deficitOk = (options.scoreDeficit ?? 0) >= config.minDeficitForCommit
  if (!wallOk && !deficitOk) return { route, actions, collapsed: false }
  const chaseWorth = routePayoff(route, options.basePoints) >= (options.immediateWinPayment ?? 0) * config.declineWinRatio
  const kept = actions.filter(action => {
    if (action.kind === 'discard' && typeof action.index === 'number') {
      const after = hand.filter((_, index) => index !== action.index)
      return routeKeepsProgress(after, melds, jokers, route, config)
    }
    if (action.kind === 'win') return !chaseWorth
    return action.kind === 'pass'
  })
  if (!kept.length) return { route, actions, collapsed: false }
  return { route, actions: kept, collapsed: true }
}
