// 血流 EV 决策上下文：本地 AI 决策与 LLM 候选特征共用同一套计算结果（单一事实来源）。
// 只读计算，不提交任何动作；封顶/事件倍率口径与 engine 的 ownScore 一致。
import type { Meld, TileType } from '../../../core/contracts/types'
import type { BloodFlowAiConfig } from './config'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG } from './config'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'
import { forecastSelfDrawIncome, forecastCalibratedIncome } from './incomeForecast'
import { forecastConditionalIncome } from './conditionalRon'
import {
  chainEvEst, patternPotentialEv, patternPotentialTotal, patternPotentials,
  waitingTilesCached, type PatternDirection,
} from './patternPotentials'

/** 首胡门槛（单家支付，合法 10 的倍数档），按墙余分段。 */
export function firstWinFloor(wallCount: number, config: BloodFlowAiConfig) {
  if (wallCount <= config.lateGameWallCount) return config.firstWinFloorLate
  if (wallCount > config.earlyGameWallCount) return config.firstWinFloorEarly
  return config.firstWinFloorMid
}

export type EvFloorStage = 'early' | 'mid' | 'late'

export interface ReformCandidateInfo {
  index: number
  tile: TileType
  ev: number
  anyWait: boolean
  waitCount: number
  /** 弃后手牌的潜力方向（番型中文名，最多 3 个）。 */
  patterns: string[]
}

export interface BloodFlowEvContext {
  locked: boolean
  wallCount: number
  drawnIndex: number
  hand: readonly TileType[]
  melds: readonly Readonly<Meld>[]
  jokers: readonly TileType[]
  winOffered: boolean
  /** 本窗口立即总收（引擎精确分；无胡候选为 0）。 */
  immediateTotal: number
  /** 胡后锁手形态的连锁期望（点）。 */
  chainAfterWin: number
  winEv: number
  floor: number
  floorStage: EvFloorStage
  /** 拒胡所需的改造潜力（Σ weight×progress²）。 */
  potentialTotal: number
  topDirections: PatternDirection[]
  /** 过/拒胡的继续发育期望（点）。 */
  developEv: number
  /** 自摸窗口改张候选（按 EV 降序；仅未锁手且窗口有胡时计算）。 */
  reformCandidates: ReformCandidateInfo[]
  /** 抢杠窗口的胡/过两值；非抢杠窗口为 null。 */
  robEv: { winEv: number; passEv: number } | null
}

export function bloodFlowEvContext(view: BloodFlowSeatView, config: BloodFlowAiConfig = BLOOD_FLOW_AI): BloodFlowEvContext {
  const player = view.players[view.seat]
  const locked = view.public.seats[view.seat].locked
  const hand = player.hand
  const melds = player.melds
  const jokers = view.jokers
  const visible = visibleTiles(view)
  const wallCount = view.wallCount
  const sourceSeat = view.window?.source.seat ?? view.seat
  const drawOffset = ((view.seat - sourceSeat + 4) % 4) || 4
  const chain = (tiles: readonly TileType[], offset = drawOffset) => config.chainForecast === 'source-v2' && config.opportunityCalibration
    ? config.conditionalRon
      ? forecastConditionalIncome(tiles,melds,jokers,visible,wallCount,config.chainHorizon,offset,config.opportunityCalibration,
        view.seat,view.public.seats.map(s=>s.locked),config.conditionalRon)
      : forecastCalibratedIncome(tiles, melds, jokers, visible, wallCount, config.chainHorizon, offset, config.opportunityCalibration)
    : config.chainForecast === 'self-draw-v1'
    ? forecastSelfDrawIncome(tiles, melds, jokers, visible, wallCount, config.chainHorizon, offset)
    : chainEvEst(tiles, melds, jokers, visible, wallCount, config.sevenPairsModel, config)
  const drawnIndex = player.drawnTileIndex
  const window = view.window
  const winOffered = view.ownActions.some(action => action.kind === 'win')
  const score = view.ownScore
  const payers = score && (score.source === 'self-draw' || score.source === 'kong-bloom') ? 3 : 1
  const immediateTotal = (score?.paymentPerPayer ?? 0) * payers
  // 自摸胡后摸牌归档：锁手形态 = 手牌去掉摸牌位；点炮/抢杠形态 = 当前 13 张。
  const lockedHand = window?.kind === 'turn' && drawnIndex >= 0
    ? hand.filter((_, index) => index !== drawnIndex) : [...hand]
  const chainAfterWin = winOffered ? chain(lockedHand) : 0
  const winEv = immediateTotal + chainAfterWin
  const floor = firstWinFloor(wallCount, config)
  const floorStage: EvFloorStage = wallCount <= config.lateGameWallCount ? 'late'
    : wallCount > config.earlyGameWallCount ? 'early' : 'mid'
  const potentialTotal = patternPotentialTotal(lockedHand, melds, jokers, config.sevenPairsModel)
  const topDirections = [...patternPotentials(lockedHand, melds, jokers, config.sevenPairsModel)]
    .sort((a, b) => b.score - a.score).slice(0, 3)
  const developEv = patternPotentialEv(lockedHand, melds, jokers, wallCount, config.sevenPairsModel, config)

  const reformCandidates: ReformCandidateInfo[] = []
  if (!locked && window?.kind === 'turn' && window.source.kind === 'draw' && drawnIndex >= 0 && winOffered) {
    for (const action of view.ownActions) {
      if (action.kind !== 'discard' || action.index === drawnIndex) continue
      const after = hand.filter((_, index) => index !== action.index)
      const waits = waitingTilesCached(after, melds.length, jokers)
      if (!waits.length) continue
      reformCandidates.push({
        index: action.index,
        tile: hand[action.index],
        ev: chain(after),
        anyWait: waits.length >= 34,
        waitCount: waits.length,
        patterns: [...patternPotentials(after, melds, jokers, config.sevenPairsModel)]
          .sort((a, b) => b.score - a.score).slice(0, 3)
          .map(direction => BLOOD_FLOW_CONFIG.patterns[direction.id].label),
      })
    }
    reformCandidates.sort((a, b) => b.ev - a.ev)
  }

  let robEv: BloodFlowEvContext['robEv'] = null
  if (!locked && window?.kind !== 'turn' && window.source.kind === 'added-kong' && winOffered) {
    const kongFee = BLOOD_FLOW_CONFIG.basePoints * BLOOD_FLOW_CONFIG.kongPayments.added
    robEv = {
      winEv,
      // 过抢杠后杠家先补摸一张；抢胡则从其下家继续。
      passEv: -kongFee + chain(hand, drawOffset + 1)
        + patternPotentialEv(hand, melds, jokers, wallCount, config.sevenPairsModel, config),
    }
  }

  return {
    locked, wallCount, drawnIndex, hand, melds, jokers, winOffered,
    immediateTotal, chainAfterWin, winEv, floor, floorStage,
    potentialTotal, topDirections, developEv, reformCandidates, robEv,
  }
}
