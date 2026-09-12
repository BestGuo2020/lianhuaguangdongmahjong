import type { Meld, TileType } from '../../../core/contracts/types'
import { decideTurn, decideClaim, lotusDiscardCandidates, chooseFallbackDiscardIndex } from '../lotusAi'
import { canChi } from '../lotusRules'
import type { BloodFlowAction } from './state'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'
import type { BloodFlowAiConfig } from './config'
import { BLOOD_FLOW_AI } from './config'
import { patternPotentialEv } from './patternPotentials'
import { bloodFlowEvContext } from './evContext'
import { opponentPatternExposure, opponentRiskProfiles, type OpponentRiskProfile } from '../../../shared/ai/opponentPatternRisk'

export { bloodFlowEvContext, firstWinFloor } from './evContext'

/** Only adapt blood-flow legal/locked actions. Tile strategy belongs to lotusAi. */
export function bloodFlowAiActions(view: BloodFlowSeatView): readonly BloodFlowAction[] {
  if (view.public.seats[view.seat].locked) return view.ownActions
  const indices = view.ownActions.filter(a => a.kind === 'discard').map(a => a.index)
  const allowed = new Set(lotusDiscardCandidates(view.players[view.seat].hand, view.jokers, indices).map(c => c.index))
  return view.ownActions.filter(a => a.kind !== 'discard' || allowed.has(a.index))
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
  const moves = bloodFlowAiActions(view)
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

  if (discards.length) return decideDiscard()
  return decideClaimTurn()
}
