// 玩家自摸窗口的改张提示计算（与 AI 策略同源：同一权重/比例/封顶口径）。
// 只做纯计算，不提交任何动作；抢杠与点炮窗口不产生提示。
import type { TileType } from '../../../core/contracts/types'
import type { WaitScores } from '../patterns/handWaits'
import type { PublicWinScore } from './types'
import type { BloodFlowAiConfig } from './config'
import { BLOOD_FLOW_AI } from './config'

export interface ReformHint {
  readonly discard: TileType
  readonly reason: 'any-wait' | 'better'
  /** 改张 EV − 立即胡 EV 的估算差（点）。 */
  readonly gain: number
}

function chainOf(waits: WaitScores, visible: readonly TileType[], wallCount: number, config: BloodFlowAiConfig) {
  const chainFactor = Math.min(1, config.chainHorizon / Math.max(1, wallCount / 4))
  let total = 0
  for (const item of waits) {
    const remaining = Math.max(0, 4 - visible.filter(tile => tile === item.tile).length)
    if (!remaining || !item.selfDraw || !item.discard) continue
    const average = (config.selfDrawWeight * item.selfDraw.paymentPerPayer * 3 + item.discard.paymentPerPayer)
      / (config.selfDrawWeight + 1)
    total += remaining * average * chainFactor
  }
  return total
}

/**
 * 自摸窗口改张提示：摸牌能胡、未锁手时，枚举「弃别的牌保留摸牌」的听口，
 * 取连锁期望最大者；达到 reformGainRatio × 立即胡 EV 才提示。
 */
export function computeReformHint(input: {
  hand: readonly TileType[]
  drawnTileIndex: number
  wallCount: number
  visible: readonly TileType[]
  ownScore: PublicWinScore
  hints: { current: WaitScores; discards: { discard: TileType; waits: WaitScores }[] }
  config?: BloodFlowAiConfig
}): ReformHint | null {
  if (input.wallCount <= 0) return null
  const config = input.config ?? BLOOD_FLOW_AI
  const payers = input.ownScore.source === 'self-draw' || input.ownScore.source === 'kong-bloom' ? 3 : 1
  const winTotal = input.ownScore.paymentPerPayer * payers
  const winEv = winTotal + chainOf(input.hints.current, input.visible, input.wallCount, config)
  const drawnTile = input.hand[input.drawnTileIndex]
  let best: { discard: TileType; ev: number; anyWait: boolean } | null = null
  for (const item of input.hints.discards) {
    if (item.discard === drawnTile || !item.waits.length) continue
    const ev = chainOf(item.waits, input.visible, input.wallCount, config)
    if (!best || ev > best.ev) best = { discard: item.discard, ev, anyWait: item.waits.length >= 34 }
  }
  if (!best || best.ev < winEv * config.reformGainRatio) return null
  return { discard: best.discard, reason: best.anyWait ? 'any-wait' : 'better', gain: Math.round(best.ev - winEv) }
}
