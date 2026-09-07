import type { Meld, TileType } from '../../../core/contracts/types'
import { decideTurn, decideClaim, lotusDiscardCandidates, chooseFallbackDiscardIndex } from '../lotusAi'
import { canChi } from '../lotusRules'
import type { BloodFlowAction } from './state'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'
import type { BloodFlowAiConfig } from './config'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG } from './config'
import { chainEvEst, patternPotentialEv, patternPotentialTotal, waitingTilesCached } from './patternPotentials'

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

function firstWinFloor(wallCount: number, config: BloodFlowAiConfig) {
  if (wallCount <= config.lateGameWallCount) return config.firstWinFloorLate
  if (wallCount > config.earlyGameWallCount) return config.firstWinFloorEarly
  return config.firstWinFloorMid
}

/** 放炮成本：牌河公开张数档位 × 按 4 倍级单家支付（40 点）估算的暴露。 */
function safetyExposureFor(config: BloodFlowAiConfig, visible: readonly TileType[]) {
  return (tile: TileType) => {
    let count = 0
    for (const visibleTile of visible) if (visibleTile === tile) count += 1
    const ladder = count >= 2 ? config.safetyCostSafe : count === 1 ? config.safetyCostOne : config.safetyCostNone
    return ladder * 40
  }
}

interface EvExtras {
  patternBonus: (hand: TileType[], melds: Meld[]) => number
  safetyExposure: (tile: TileType) => number
  melds: Meld[]
}

/** 自摸窗口的改张候选：弃别的牌保留摸牌，且弃后仍听牌，取连锁期望最大者。 */
function bestReformDiscard(
  moves: readonly BloodFlowAction[], hand: readonly TileType[], drawnIndex: number,
  melds: readonly Readonly<Meld>[], jokers: readonly TileType[], visible: readonly TileType[],
  wallCount: number, winEv: number, config: BloodFlowAiConfig,
): BloodFlowAction | null {
  let best: { action: BloodFlowAction; ev: number } | null = null
  for (const discard of moves) {
    if (discard.kind !== 'discard' || discard.index === drawnIndex) continue
    const after = hand.filter((_, index) => index !== discard.index)
    if (!waitingTilesCached(after, melds.length, jokers).length) continue
    const ev = chainEvEst(after, melds, jokers, visible, wallCount)
    if (!best || ev > best.ev) best = { action: discard, ev }
  }
  return best && best.ev >= winEv * config.reformGainRatio ? best.action : null
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
    safetyExposure: safetyExposureFor(config, visible),
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
    const score = view.ownScore
    const payers = score && (score.source === 'self-draw' || score.source === 'kong-bloom') ? 3 : 1
    const immediateTotal = (score?.paymentPerPayer ?? 0) * payers
    const drawnIndex = player.drawnTileIndex
    const lockedHand = view.window?.kind === 'turn' && drawnIndex >= 0
      ? hand.filter((_, index) => index !== drawnIndex) : [...hand]
    const winEv = immediateTotal + chainEvEst(lockedHand, melds, jokers, visible, wallCount)

    // 自摸窗口：改张优先于门槛，再决定胡或继续发育。
    if (view.window?.kind === 'turn' && view.window.source.kind === 'draw' && drawnIndex >= 0) {
      const reform = bestReformDiscard(moves, hand, drawnIndex, melds, jokers, visible, wallCount, winEv, config)
      if (reform) return reform
      const belowFloor = Boolean(score && score.paymentPerPayer < firstWinFloor(wallCount, config))
      if (belowFloor && patternPotentialTotal(lockedHand, melds, jokers) >= config.potentialFloor) {
        return decideDiscard() ?? (moves.find(a => a.kind === 'pass') ?? win)
      }
      return win
    }

    // 抢杠窗口：胡 / 过的贪婪比较（无改张、无吃碰杠替代用途）。
    if (view.window?.kind !== 'turn' && view.window.source.kind === 'added-kong') {
      const kongFee = BLOOD_FLOW_CONFIG.basePoints * BLOOD_FLOW_CONFIG.kongPayments.added
      const passEv = -kongFee + chainEvEst(hand, melds, jokers, visible, wallCount)
        + patternPotentialEv(hand, melds, jokers, wallCount)
      return winEv >= passEv ? win : (moves.find(a => a.kind === 'pass') ?? win)
    }

    // 点炮窗口：低于首胡门槛且手牌有潜力 → 不胡，交给常规吃碰杠比较；否则胡。
    if (score && score.paymentPerPayer < firstWinFloor(wallCount, config)
      && patternPotentialTotal(hand, melds, jokers) >= config.potentialFloor) {
      return decideClaimTurn() ?? (moves.find(a => a.kind === 'pass') ?? win)
    }
    return win
  }

  if (discards.length) return decideDiscard()
  return decideClaimTurn()
}
