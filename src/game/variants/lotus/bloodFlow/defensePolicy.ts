// 兜/弃政策（v3）：对手已做成/已知在做大牌时，本家"继续走"还是"弃胡兜安全张"。
//
// 规则来自用户定稿（2026-09-12）：
//   ① 只要能在本巡转成**精吊任意听**就继续走——锁手后每张摸到的牌都能胡、从此永不弃牌，
//      等于 100% 不再给对手点炮（`engine.ts` 锁手家只有"胡"或"摸切"两条路，任意听时永远走胡）。
//   ② 未听牌且可达听口过窄 → 立即弃胡：只打最小赔付张、停吃碰杠（本玩法没有查大叫，弃胡无期末代价）。
//   ③ 我方上限不低于对手已知/推断的牌型倍率 → 可以赌（继续进攻），不吃亏。
//
// 纯函数、确定性；只读本家手牌 + 公共信息，不推断对手暗手。
import type { TileType } from '../../../core/contracts/types'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_DEFENSE } from './config'
import { waitingTilesCached } from './patternPotentials'

export { BLOOD_FLOW_DEFENSE }

export type DefenseMode = 'push' | 'fold' | 'normal'

export interface DefensePolicyConfig {
  /** 触发"兜"的最低对手威胁档（3 = 十六倍级/门清大牌）。 */
  foldThreatTier: number
  /** 我方上限认定：番型方向接近度 ≥ 该值才算"真有机会做成"。 */
  ceilingProgress: number
  /** 我方上限认定：该方向的番型倍率权重（1/2/4/8/16）下限，用于与对手对比。 */
  ceilingWeightFloor: number
  /**
   * 硬约束开关：`'hard'`（默认）= 兜牌时在**候选层**撤掉吃碰杠、弃牌只留安全档；
   * `'off'` = 只在引擎侧选择最小赔付张，候选不收敛（LLM 仍可自由挑）。
   */
  mode: 'off' | 'hard'
  /** 兜牌时允许的弃牌"安全档"容差（0 = 只留放炮成本最小档）。 */
  foldDiscardTolerance: number
}

export const BLOOD_FLOW_DEFENSE_DEFAULT = BLOOD_FLOW_DEFENSE

export interface OwnHandFacts {
  /**
   * 本巡打出某一张后能否进入听牌态（等价于"是否存在一张弃牌让听口非空"）。
   * false = 未听牌（用户规则②的弃胡前提）。判定只用听口，不需要跑完整向听搜索。
   */
  canTenpai: boolean
  /** 本巡打某张后能达成的最大听口有效剩余张数（含现物/公开张数折算）。 */
  bestWaitRemaining: number
  /** 是否存在"打一张即单吊任意听"（34 种全胡）的弃牌。 */
  anyWaitReachable: boolean
  /** 我方可行番型上限倍率（按接近度 ≥ ceilingProgress 的方向取最大 weight）。 */
  ceilingMultiplier: number
  /** 上限来自哪个番型（给 prompt/日志用）。 */
  ceilingLabel: string | null
}

export interface OpponentThreatFacts {
  tier: number
  locked: boolean
  /** 对手已公开番型的最高倍率（无已公开番型时为 0）。 */
  knownMultiplier: number
  signals: readonly string[]
}

export interface DefensePolicyInput {
  own: OwnHandFacts
  opponents: readonly OpponentThreatFacts[]
  config?: DefensePolicyConfig
}

export interface DefensePolicyResult {
  mode: DefenseMode
  /** 全场最高威胁档与倍率（用于文案与阈值）。 */
  threatTier: number
  threatMultiplier: number
  reasons: string[]
}

/**
 * 只算"该不该兜"，不决定具体打哪张（打哪张由最小赔付规则在引擎侧算）。
 * 优先级：精吊任意听可及 > 我方上限不低于对手 > 未听牌且听口过窄则兜 > 否则正常。
 */
export function decideDefensePolicy(input: DefensePolicyInput): DefensePolicyResult {
  const config = input.config ?? BLOOD_FLOW_DEFENSE
  const { own, opponents } = input
  const threatTier = opponents.reduce((best, opponent) => Math.max(best, opponent.tier), 0)
  const threatMultiplier = opponents.reduce(
    (best, opponent) => Math.max(best, opponent.tier >= 1 ? Math.max(opponent.knownMultiplier, multiplierOfTier(opponent.tier)) : 0), 0)
  const threatening = opponents
    .filter(opponent => opponent.tier >= config.foldThreatTier)
    .sort((a, b) => b.tier - a.tier)

  if (own.anyWaitReachable) {
    return {
      mode: 'push', threatTier, threatMultiplier,
      reasons: ['打一张即精吊任意听：此后每巡必胡、永不弃牌，等于不再点炮'],
    }
  }
  if (threatening.length && own.ceilingMultiplier >= threatMultiplier && own.ceilingMultiplier >= config.ceilingWeightFloor) {
    return {
      mode: 'push', threatTier, threatMultiplier,
      reasons: [`我方上限${own.ceilingMultiplier}倍${own.ceilingLabel ? `（${own.ceilingLabel}）` : ''}不低于对手${threatMultiplier}倍，可以赌`],
    }
  }
  if (threatening.length && !own.canTenpai) {
    const top = threatening[0]
    return {
      mode: 'fold', threatTier, threatMultiplier,
      reasons: [
        `对手${top.locked ? '已锁手' : '疑似'}大牌（${top.signals.slice(0, 2).join('、') || `档位${top.tier}`}）`,
        `本家未听牌（本巡打任何一张都听不上）→ 弃胡兜安全张`,
      ],
    }
  }
  return { mode: 'normal', threatTier, threatMultiplier, reasons: [] }
}

/** 档位 → 赔付量级倍率（与 opponentPatternRisk 的 ×1/4/16/32 对应）。 */
export function multiplierOfTier(tier: number): number {
  return tier >= 3 ? 16 : tier === 2 ? 8 : tier === 1 ? 4 : 1
}

/** 本家手牌的兜/弃相关事实（打某张后的听口宽度、是否可及任意听、番型上限）。 */
export function ownHandFacts(
  hand: readonly TileType[],
  melds: readonly { tiles: readonly TileType[] }[],
  jokers: readonly TileType[],
  visibleTiles: readonly TileType[],
  options: { config?: DefensePolicyConfig; directions?: readonly { weight: number; progress: number; label: string }[] },
): OwnHandFacts {
  const config = options.config ?? BLOOD_FLOW_DEFENSE
  const exposed = melds.length
  const remaining = (tile: TileType) => Math.max(0, 4 - visibleTiles.filter(item => item === tile).length)
  let bestWaitRemaining = 0
  let anyWaitReachable = false
  let canTenpai = false
  const seen = new Set<TileType>()
  for (let index = 0; index < hand.length; index += 1) {
    const tile = hand[index]
    if (seen.has(tile)) continue
    seen.add(tile)
    const after = hand.filter((_, position) => position !== index)
    const waits = waitingTilesCached(after, exposed, jokers)
    if (!waits.length) continue
    canTenpai = true
    if (waits.length >= 34) anyWaitReachable = true
    const effective = waits.reduce((sum, wait) => sum + remaining(wait), 0)
    if (effective > bestWaitRemaining) bestWaitRemaining = effective
  }
  const directions = options.directions ?? []
  const reachable = directions.filter(direction => direction.progress >= config.ceilingProgress)
  const ceiling = reachable.reduce<{ weight: number; label: string } | null>(
    (best, direction) => (best === null || direction.weight > best.weight ? { weight: direction.weight, label: direction.label } : best), null)
  return {
    canTenpai,
    bestWaitRemaining,
    anyWaitReachable,
    ceilingMultiplier: ceiling?.weight ?? 0,
    ceilingLabel: ceiling?.label ?? null,
  }
}

/** 我方上限用的番型权重（与 BLOOD_FLOW_CONFIG.patterns 同源）。 */
export function patternWeightOf(id: string): number {
  const definition = (BLOOD_FLOW_CONFIG.patterns as Record<string, { weight: number; label: string }>)[id]
  return definition ? definition.weight : 1
}
