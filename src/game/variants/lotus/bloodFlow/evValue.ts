// 本地 EV 候选价值（**单一事实来源**）：把"某个候选值多少点"抽成可复用函数。
//
// 背景（2026-09-17，任务 ε）：ε-容忍约束要判断"本地最优与次优是不是几乎等价"
//（等价 ⇒ 模型怎么选都无所谓 ⇒ **不必调用模型**，直接照抄本地建议）。
// 这个判断必须用**与本地 EV 排序完全同式**的价值，否则门槛就没有意义。
//
// 公式逐项对齐 `lotusAi.discardQuality` 的 `netScore`（本地 EV 排序主键）：
//   netScore = attackScore + safetyScore × (残局且听牌 ? 4 : 2) + patternPotentialEv(弃牌后手牌) − safetyExposure(打出张)
//   attackScore = (听牌 ? 80 : 0) + (残局且听牌 ? 20 : 0) + 听口数×10 + 有效剩余×2 + specialScore×3
// 单位：**点**（底分 10 的同一货币）。
//
// 不同动作 kind 的取值口径（都归一到"点"）：
//   discard  → 上面的 netScore
//   win      → `evContext.winEv`（立即总收 + 锁手连锁期望）
//   pass     → `evContext.developEv`
//   peng/chi → 副露后的攻击分 + 潜力（近似；用于比较"要不要开这副露"）
//   各类杠    → `kongValue.net`
import type { Meld, TileType } from '../../../core/contracts/types'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'
import { BLOOD_FLOW_AI, type BloodFlowAiConfig } from './config'
import { bloodFlowEvContext, bloodFlowKongValue, bloodFlowSafetyExposure } from './ai'
import {
  patternPotentialEv, waitingTilesCached, wildcardSet,
  shiSanLanPotential, thirteenOrphansPotential, sevenPairsPotential,
} from './patternPotentials'
import { evaluateHandProgress } from '../../../shared/ai/handProgress'
import type { BloodFlowAction } from './state'

/** 与 `lotusAi.specialPatternScore` 同式（有副露直接 -20）。 */
export function specialPatternScore(hand: readonly TileType[], exposedMelds: number, jokers: readonly TileType[]) {
  if (exposedMelds > 0) return -20
  const wild = [...wildcardSet(jokers), 'white' as TileType]
  return Math.max(
    shiSanLanPotential(hand, wild),
    thirteenOrphansPotential(hand, wild),
    sevenPairsPotential(hand, wild),
  )
}

function progressOf(view: BloodFlowSeatView, hand: readonly TileType[], exposedMelds: number) {
  return evaluateHandProgress([...hand], {
    exposedMelds,
    wildcardTiles: [...wildcardSet(view.jokers), 'white' as TileType],
    visibleTiles: visibleTiles(view),
    waitingTiles: (tiles, exposed) => waitingTilesCached(tiles, exposed, view.jokers),
    specialHands: true,
  })
}

function publicTilesOf(view: BloodFlowSeatView) {
  return [view.flipTile, ...view.players.flatMap(p => [...p.discards, ...p.melds.flatMap(m => m.tiles)]),
    ...view.public.batches.map(b => b.source.tile)]
}

/** 打出 `index` 后的 netScore（与 `lotusAi.discardQuality` 的 netScore 逐项同式）。 */
export function discardNetScore(view: BloodFlowSeatView, index: number, config: BloodFlowAiConfig = BLOOD_FLOW_AI) {
  const player = view.players[view.seat]
  const after = player.hand.filter((_, i) => i !== index)
  const exposed = player.melds.length
  const visible = visibleTiles(view)
  const wallCount = view.wallCount
  const progress = progressOf(view, after, exposed)
  const waits = progress.waits
  const effectiveRemaining = waits.reduce(
    (total, tile) => total + Math.max(0, 4 - visible.filter(entry => entry === tile).length), 0)
  const specialScore = specialPatternScore(after, exposed, view.jokers)
  const lateGame = wallCount <= 8
  const attackScore = (waits.length > 0 ? 80 : 0) + (lateGame && waits.length ? 20 : 0)
    + waits.length * 10 + effectiveRemaining * 2 + specialScore * 3
  const publicTiles = publicTilesOf(view)
  const discarded = player.hand[index]
  const publicCount = publicTiles.filter(tile => tile === discarded).length
  let safetyScore = publicCount >= 3 ? 24 : publicCount >= 2 ? 12 : publicCount >= 1 ? 4 : 0
  if (view.players[(view.seat + 3) % 4]?.discards.at(-1) === discarded) safetyScore += 12
  const suited = /^([mps])([1-9])$/.exec(discarded)
  if (suited && (suited[2] === '1' || suited[2] === '7') && publicTiles.includes(`${suited[1]}4` as TileType)) {
    safetyScore += 5
  }
  const patternBonus = patternPotentialEv(
    after, player.melds as readonly Meld[], view.jokers, wallCount, config.sevenPairsModel)
  const exposure = bloodFlowSafetyExposure(view, config, visible)(discarded)
  return attackScore + safetyScore * (lateGame && waits.length ? 4 : 2) + patternBonus - exposure
}

/** 副露（碰/吃）后的近似价值（与弃牌 netScore 同一套攻击分 + 潜力口径）。 */
export function claimApproxValue(
  view: BloodFlowSeatView, action: Extract<BloodFlowAction, { kind: 'peng' | 'chi' }>,
  config: BloodFlowAiConfig = BLOOD_FLOW_AI,
) {
  const player = view.players[view.seat]
  const source = view.window?.source
  const tile = source?.kind === 'discard' ? source.tile : undefined
  let after: TileType[] = [...player.hand]
  if (action.kind === 'peng') {
    let removed = 0
    after = player.hand.filter(entry => !(entry === tile && removed++ < 2))
  } else {
    for (const meldTile of action.tiles) {
      if (meldTile === tile) continue
      const at = after.indexOf(meldTile)
      if (at >= 0) after.splice(at, 1)
    }
  }
  const exposed = player.melds.length + 1
  const progress = progressOf(view, after, exposed)
  const attack = (progress.waits.length > 0 ? 80 : 0) + progress.waits.length * 10 + progress.effectiveRemaining * 2
  return attack + patternPotentialEv(
    after, player.melds as readonly Meld[], view.jokers, view.wallCount, config.sevenPairsModel)
}

/** 单个动作的本地价值（点）。 */
export function actionValue(
  view: BloodFlowSeatView, action: BloodFlowAction, config: BloodFlowAiConfig = BLOOD_FLOW_AI,
): number {
  switch (action.kind) {
    case 'discard': return discardNetScore(view, action.index, config)
    case 'win': return bloodFlowEvContext(view, config).winEv
    case 'pass': return bloodFlowEvContext(view, config).developEv
    case 'peng':
    case 'chi': return claimApproxValue(view, action, config)
    case 'gang':
    case 'added-kong':
    case 'concealed-kong':
    case 'wind-kong': return bloodFlowKongValue(view, action, config)?.net ?? 0
    default: return 0
  }
}

export interface ScoredAction {
  action: BloodFlowAction
  value: number
}

/** 一组动作的价值向量（按价值降序）。 */
export function valueVector(
  view: BloodFlowSeatView, actions: readonly BloodFlowAction[], config: BloodFlowAiConfig = BLOOD_FLOW_AI,
): ScoredAction[] {
  const entries = actions.map(action => ({ action, value: actionValue(view, action, config) }))
  entries.sort((a, b) => b.value - a.value)
  return entries
}

/** 建议动作是否落在候选集里（按语义匹配；discard 按牌面，因为大牌路线收窄会改索引）。 */
export function suggestionInOffered(
  view: BloodFlowSeatView, offered: readonly BloodFlowAction[], suggestion: BloodFlowAction | null,
): boolean {
  if (!suggestion) return false
  const hand = view.players[view.seat].hand
  const tile = suggestion.kind === 'discard' ? hand[suggestion.index] : null
  return offered.some(candidate => {
    if (candidate.kind !== suggestion.kind) return false
    if (candidate.kind === 'discard' && suggestion.kind === 'discard') {
      return hand[candidate.index] === tile
    }
    if (candidate.kind === 'chi' && suggestion.kind === 'chi') {
      return candidate.tiles.join() === suggestion.tiles.join()
    }
    if (candidate.kind === 'added-kong' && suggestion.kind === 'added-kong') {
      return candidate.meldIndex === suggestion.meldIndex
    }
    return true
  })
}
