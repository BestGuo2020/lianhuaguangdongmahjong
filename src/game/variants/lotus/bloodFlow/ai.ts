import type { Meld, TileType } from '../../../core/contracts/types'
import { decideTurn, decideClaim, lotusDiscardCandidates, chooseFallbackDiscardIndex } from '../lotusAi'
import { canChi } from '../lotusRules'
import type { BloodFlowAction } from './state'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'
import type { BloodFlowAiConfig } from './config'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG } from './config'
import { patternPotentialEv, patternPotentials, waitingTilesCached } from './patternPotentials'
import { bloodFlowEvContext } from './evContext'
import { opponentPatternExposure, opponentRiskProfiles, type OpponentRiskProfile } from '../../../shared/ai/opponentPatternRisk'
import { decideDefensePolicy, ownHandFacts, type DefensePolicyConfig } from './defensePolicy'
import { evaluateHandProgress } from '../../../shared/ai/handProgress'

export { bloodFlowEvContext, firstWinFloor } from './evContext'

/** Only adapt blood-flow legal/locked actions. Tile strategy belongs to lotusAi. */
export function bloodFlowAiActions(
  view: BloodFlowSeatView, config: BloodFlowAiConfig = BLOOD_FLOW_AI,
  /** 调用方已算过的政策（避免一次决策里重复算全手牌型/向听）。 */
  defense?: ReturnType<typeof bloodFlowDefensePolicy>,
): readonly BloodFlowAction[] {
  if (view.public.seats[view.seat].locked) return view.ownActions
  const indices = view.ownActions.filter(a => a.kind === 'discard').map(a => a.index)
  const allowed = new Set(lotusDiscardCandidates(view.players[view.seat].hand, view.jokers, indices).map(c => c.index))
  const legal = view.ownActions.filter(a => a.kind !== 'discard' || allowed.has(a.index))
  return applyDefenseConstraint(view, dropDominatedPeng(legal), config, defense)
}

const CLAIM_KINDS: ReadonlySet<string> = new Set(['peng', 'chi', 'gang', 'added-kong', 'concealed-kong', 'wind-kong'])

/**
 * 兜牌模式的硬约束（v3，用户定稿方案 c）：候选层直接收窄，引擎与 LLM 共用同一份候选——
 *   ① 撤掉全部吃碰杠候选（不给自己制造"必须打危险张"的局面）；
 *   ② 弃牌候选只保留放炮成本最小档的那些（让模型只能在安全张里挑怎么打）；
 *   ③ 两个出口不受限：能打一张即精吊任意听、或我方上限不低于对手时，政策本身就是 push，不触发约束。
 * 胡永远保留（不会因为兜牌而放过已经能胡的牌）。
 */
function applyDefenseConstraint(
  view: BloodFlowSeatView, actions: readonly BloodFlowAction[], config: BloodFlowAiConfig,
  precomputed?: ReturnType<typeof bloodFlowDefensePolicy>,
): readonly BloodFlowAction[] {
  if (config.defense.mode === 'off') return actions
  const defense = precomputed ?? bloodFlowDefensePolicy(view, config)
  if (defense.result.mode !== 'fold') return actions
  const keepWinPass = (action: BloodFlowAction) => action.kind === 'win' || action.kind === 'pass'
  const discards = actions.filter((action): action is Extract<BloodFlowAction, { kind: 'discard' }> => action.kind === 'discard')
  if (!discards.length) return actions.filter(action => keepWinPass(action))
  const exposure = bloodFlowSafetyExposure(view, config)
  const hand = view.players[view.seat].hand
  const costs = discards.map(action => exposure(hand[action.index]))
  const floor = Math.min(...costs)
  const safe = new Set(discards
    .filter((_, position) => costs[position] <= floor + config.defense.foldDiscardTolerance)
    .map(action => action.index))
  return actions.filter(action => (action.kind === 'discard' ? safe.has(action.index) : keepWinPass(action)))
}

/**
 * 能大明杠时不给"碰"候选（与非血流 `candidates.ts` 的 `pengWouldDiscardClaimedTile` 守卫、以及
 * 本地 AI `decideClaim` 的"能杠必杠"一致）。
 *
 * 为什么杠严格优于碰：响应别人弃牌时手上必然是 3 张（第四张在弃牌里），碰会把这 3 张拆成
 * "副露 2 张 + 手里留 1 张死牌"，而杠是同一副露 + 杠分 + 补牌机会，且大明杠不可被抢。
 * 之前血流 LLM 候选直接照搬合法动作，模型可以选"碰"，下一手再把多出来那张打掉——
 * 表现就是"本来能开大明杠，结果碰牌 + 打出要碰的牌"。
 */
function dropDominatedPeng(actions: readonly BloodFlowAction[]): readonly BloodFlowAction[] {
  if (!actions.some(action => action.kind === 'gang')) return actions
  return actions.filter(action => action.kind !== 'peng')
}

/** 旧策略入口（legacy）：见胡就胡 + 固定首胡门槛，行为保持不变。 */
export function decideBloodFlowAction(view: BloodFlowSeatView, minimumFirstPayment = 0): BloodFlowAction | null {
  const player = view.players[view.seat]
  const moves = bloodFlowAiActions(view)
  if (!moves.length) return null
  if (moves.length === 1) return moves[0]
  const locked = view.public.seats[view.seat].locked
  const win = moves.find(a => a.kind === 'win')
  if (win) return locked || (view.ownScore?.paymentPerPayer ?? 0) >= minimumFirstPayment
    ? win : moves.find(a => a.kind === 'pass')!
  const context = { hand: player.hand, jokers: view.jokers, exposedMelds: player.melds.length,
    visibleTiles: visibleTiles(view), wallCount: view.wallCount,
    upperLastDiscard: view.players[(view.seat + 3) % 4]?.discards.at(-1), earlyRound: player.discards.length < 2,
    publicTiles: [view.flipTile, ...view.players.flatMap(p => [...p.discards, ...p.melds.flatMap(m => m.tiles)]),
      ...view.public.batches.map(b => b.source.tile)],
  }
  const offered = (action: BloodFlowAction) => moves.find(a => JSON.stringify(a) === JSON.stringify(action))
  const discards = moves.filter(a => a.kind === 'discard')
  const fallback = () => {
    const index = chooseFallbackDiscardIndex(player.hand, view.jokers, discards.map(d => d.index))
    return discards.find(a => a.index === index) ?? null
  }
  if (discards.length) {
    if (locked) return discards[0]
    try {
      const decision = decideTurn({ ...context, melds: player.melds, kongBloom: false }, () => 0)
      const action: BloodFlowAction = decision.kind === 'discard' ? { kind: 'discard', index: decision.handIndex } : decision
      return offered(action) ?? fallback()
    } catch { return fallback() }
  }
  const pass = moves.find(a => a.kind === 'pass') ?? null
  if (view.window?.source.kind !== 'discard') return pass
  try {
    const source = view.window.source
    const decision = decideClaim({ ...context, tile: source.tile, from: source.seat,
      canGang: moves.some(a => a.kind === 'gang'), canPeng: moves.some(a => a.kind === 'peng'),
      chiOptions: canChi(player.hand, source.tile, view.jokers).filter(m => offered({ kind: 'chi', tiles: m.tiles })),
    })
    return offered(decision.kind === 'chi' ? { kind: 'chi', tiles: decision.meld.tiles }
      : decision.kind === 'peng' ? { kind: 'peng' } : decision) ?? pass
  } catch { return pass }
}

// ── 贪婪 EV 策略（docs/blood-flow/design/ai-strategy.md） ──
// EV 上下文（胡/连锁/门槛/潜力/改张/抢杠两值）由 evContext 统一计算，
// 本地决策与 LLM 候选特征共用同一份结果。

/** 放炮成本（旧口径）：牌河公开张数档位 × 按 4 倍级单家支付（40 点）估算的暴露。 */
function safetyExposureFor(config: BloodFlowAiConfig, visible: readonly TileType[]) {
  return (tile: TileType) => {
    let count = 0
    for (const visibleTile of visible) if (visibleTile === tile) count += 1
    const ladder = count >= 2 ? config.safetyCostSafe : count === 1 ? config.safetyCostOne : config.safetyCostNone
    return ladder * 40
  }
}

/** config → 风险模块调参（前后端同源，见 shared/ai/opponentPatternRisk.ts）。 */
export function bloodFlowRiskTuning(config: BloodFlowAiConfig) {
  return {
    factorTier1: config.riskFactorTier1, factorTier2: config.riskFactorTier2, factorTier3: config.riskFactorTier3,
    offSuitFactor: config.riskOffSuitFactor, exposureUnit: 40,
    safetyCostNone: config.safetyCostNone, safetyCostOne: config.safetyCostOne, safetyCostSafe: config.safetyCostSafe,
    lateGameWallCount: config.lateGameWallCount,
  }
}

/**
 * 对手牌型风险档（只用公共信息）。血流额外带入已胡次数、锁手与**已公开番型**。
 * `opponentPatternRisk: 'off'` 时返回空数组，调用方回退旧口径。
 */
export type BloodFlowOpponentRisk = OpponentRiskProfile & { seat: number }

/** 从公共批次里取某座位的历次胡牌番型（PublicWinScore.items + patternMultiplier，玩家视角本就公开）。 */
function knownWinsOf(view: BloodFlowSeatView, seat: number) {
  return view.public.batches
    .flatMap(batch => batch.winners
      .filter(win => win.winner === seat)
      .flatMap(win => win.score.items.map(item => ({
        id: item.id, label: item.label, multiplier: win.score.patternMultiplier,
        tile: batch.source.tile,
      }))))
}

export function bloodFlowOpponentRisk(view: BloodFlowSeatView, config: BloodFlowAiConfig = BLOOD_FLOW_AI): BloodFlowOpponentRisk[] {
  if (config.opponentPatternRisk === 'off') return []
  const seats = view.players.filter(player => player.seat !== view.seat).map(player => player.seat)
  return opponentRiskProfiles({
    wallCount: view.wallCount,
    tuning: bloodFlowRiskTuning(config),
    opponents: seats.map(seat => ({
      discards: view.players[seat]?.discards ?? [], melds: view.players[seat]?.melds ?? [],
      winCount: view.public.seats[seat]?.winCount ?? 0,
      locked: view.public.seats[seat]?.locked ?? false,
      knownWins: knownWinsOf(view, seat),
    })),
  }).map((profile, position) => ({ ...profile, seat: seats[position] ?? position }))
}

/** 弃牌放炮成本：无风险信号时与旧口径逐位一致。 */
export function bloodFlowSafetyExposure(
  view: BloodFlowSeatView, config: BloodFlowAiConfig = BLOOD_FLOW_AI,
  visible: readonly TileType[] = visibleTiles(view),
): (tile: TileType) => number {
  const profiles = bloodFlowOpponentRisk(view, config)
  if (!profiles.length) return safetyExposureFor(config, visible)
  return opponentPatternExposure(profiles, visible, bloodFlowRiskTuning(config))
}

/** 每座位的公开番型（供 prompt、政策与后端镜像共用）。 */
export function bloodFlowKnownWins(view: BloodFlowSeatView): Array<{ seat: number; patterns: Array<{ label: string; multiplier: number }> }> {
  return view.players
    .map(player => ({
      seat: player.seat,
      patterns: knownWinsOf(view, player.seat).map(win => ({ label: win.label, multiplier: win.multiplier })),
    }))
    .filter(entry => entry.patterns.length > 0)
}

/**
 * 兜/弃政策（v3）：对手已做成大牌时本家"继续走"还是"弃胡兜安全张"。
 * 规则见 defensePolicy.ts 顶部注释（用户定稿的两条兜牌法 + 一条赌的出口）。
 */
export function bloodFlowDefensePolicy(view: BloodFlowSeatView, config: BloodFlowAiConfig = BLOOD_FLOW_AI) {
  const player = view.players[view.seat]
  const visible = visibleTiles(view)
  const wildcards: TileType[] = [...new Set<TileType>([...view.jokers, 'white'])]
  const profiles = bloodFlowOpponentRisk(view, config)
  const own = ownHandFacts(player.hand, player.melds, view.jokers, visible, {
    config: config.defense,
    directions: patternPotentials(player.hand, player.melds, view.jokers)
      .map(direction => ({ weight: direction.weight, progress: direction.progress, label: BLOOD_FLOW_CONFIG.patterns[direction.id].label })),
  })
  const opponents = view.players
    .filter(other => other.seat !== view.seat)
    .map(other => {
      const profile = profiles.find(item => item.seat === other.seat)
      return {
        tier: profile?.tier ?? 0,
        locked: view.public.seats[other.seat]?.locked ?? false,
        knownMultiplier: knownWinsOf(view, other.seat).reduce((best, win) => Math.max(best, win.multiplier), 0),
        signals: profile?.signals ?? [],
      }
    })
  return { own, result: decideDefensePolicy({ own, opponents, config: config.defense }) }
}

interface EvExtras {
  patternBonus: (hand: TileType[], melds: Meld[]) => number
  safetyExposure: (tile: TileType) => number
  melds: Meld[]
}

/**
 * 贪婪 EV 决策：胡 / 改张 / 吃碰杠 / 过 全部折算期望收益，取最大者。
 * 锁手后不变（有胡就胡、摸打、自动过）；计分、封顶、锁手规则零改动。
 */
export function decideBloodFlowActionEv(view: BloodFlowSeatView, config: BloodFlowAiConfig = BLOOD_FLOW_AI): BloodFlowAction | null {
  const player = view.players[view.seat]
  // 政策一次决策只算一遍；候选构造与兜牌分支共用（硬约束下候选必须用同一份 config）。
  const defense = config.defense.mode === 'off' ? undefined : bloodFlowDefensePolicy(view, config)
  const moves = bloodFlowAiActions(view, config, defense)
  if (!moves.length) return null
  if (moves.length === 1) return moves[0]
  const locked = view.public.seats[view.seat].locked
  const win = moves.find(a => a.kind === 'win')
  if (locked) return win ?? moves.find(a => a.kind === 'pass') ?? moves[0]

  const hand = player.hand
  const melds = player.melds
  const jokers = view.jokers
  const visible = visibleTiles(view)
  const wallCount = view.wallCount
  const extras: EvExtras = {
    patternBonus: (tiles, currentMelds) => patternPotentialEv(tiles, currentMelds, jokers, wallCount),
    safetyExposure: bloodFlowSafetyExposure(view, config, visible),
    melds,
  }
  const context = { hand, jokers, exposedMelds: melds.length, visibleTiles: visible, wallCount,
    upperLastDiscard: view.players[(view.seat + 3) % 4]?.discards.at(-1), earlyRound: player.discards.length < 2,
    publicTiles: [view.flipTile, ...view.players.flatMap(p => [...p.discards, ...p.melds.flatMap(m => m.tiles)]),
      ...view.public.batches.map(b => b.source.tile)],
  }
  const offered = (action: BloodFlowAction) => moves.find(a => JSON.stringify(a) === JSON.stringify(action))
  const discards = moves.filter(a => a.kind === 'discard')
  const fallback = () => {
    const index = chooseFallbackDiscardIndex(hand, jokers, discards.map(d => d.index))
    return discards.find(a => a.index === index) ?? null
  }
  const decideDiscard = () => {
    try {
      const decision = decideTurn({ ...context, melds, kongBloom: false, patternBonus: extras.patternBonus, safetyExposure: extras.safetyExposure }, () => 0)
      const action: BloodFlowAction = decision.kind === 'discard' ? { kind: 'discard', index: decision.handIndex } : decision
      return offered(action) ?? fallback()
    } catch { return fallback() }
  }
  const decideClaimTurn = () => {
    const pass = moves.find(a => a.kind === 'pass') ?? null
    if (view.window?.source.kind !== 'discard') return pass
    try {
      const source = view.window.source
      const decision = decideClaim({ ...context, melds, patternBonus: extras.patternBonus, safetyExposure: extras.safetyExposure,
        tile: source.tile, from: source.seat, canGang: moves.some(a => a.kind === 'gang'),
        canPeng: moves.some(a => a.kind === 'peng'),
        chiOptions: canChi(hand, source.tile, jokers).filter(m => offered({ kind: 'chi', tiles: m.tiles })),
      })
      return offered(decision.kind === 'chi' ? { kind: 'chi', tiles: decision.meld.tiles }
        : decision.kind === 'peng' ? { kind: 'peng' } : decision) ?? pass
    } catch { return pass }
  }

  if (win) {
    const ev = bloodFlowEvContext(view, config)
    // 自摸窗口：改张优先于门槛，再决定胡或继续发育。
    if (view.window?.kind === 'turn' && view.window.source.kind === 'draw' && player.drawnTileIndex >= 0) {
      const best = ev.reformCandidates.find(candidate => discards.some(d => d.index === candidate.index))
      if (best && best.ev >= ev.winEv * config.reformGainRatio) {
        return discards.find(d => d.index === best.index) ?? win
      }
      const belowFloor = Boolean(view.ownScore && view.ownScore.paymentPerPayer < ev.floor)
      if (belowFloor && ev.potentialTotal >= config.potentialFloor) {
        return decideDiscard() ?? (moves.find(a => a.kind === 'pass') ?? win)
      }
      return win
    }

    // 抢杠窗口：胡 / 过的贪婪比较（无改张、无吃碰杠替代用途）。
    if (view.window?.kind !== 'turn' && view.window.source.kind === 'added-kong') {
      const rob = ev.robEv
      return rob && rob.winEv >= rob.passEv ? win : (moves.find(a => a.kind === 'pass') ?? win)
    }

    // 点炮窗口：低于首胡门槛且手牌有潜力 → 不胡，交给常规吃碰杠比较；否则胡。
    if (view.ownScore && view.ownScore.paymentPerPayer < ev.floor
      && ev.potentialTotal >= config.potentialFloor) {
      return decideClaimTurn() ?? (moves.find(a => a.kind === 'pass') ?? win)
    }
    return win
  }

  if (discards.length) {
    // 兜/弃政策（v3）：对手已做成十六倍级大牌、本家未听牌且可达听口过窄 → 弃胡，改打最小赔付张。
    // 有胡的窗口在前面就返回了，所以这里不会"放过已经能胡的牌"。
    if (defense?.result.mode === 'fold') {
      const exposure = extras.safetyExposure
      return [...discards]
        .sort((a, b) => exposure(hand[(a as { index: number }).index]) - exposure(hand[(b as { index: number }).index])
          || (a as { index: number }).index - (b as { index: number }).index)[0]
    }
    return decideDiscard()
  }
  // 兜牌模式下停吃碰杠（不给自己制造必须打危险张的局面）。
  if (defense?.result.mode === 'fold') {
    return moves.find(a => a.kind === 'pass') ?? moves[0]
  }
  return decideClaimTurn()
}
