// 把赛后复现数据还原成引擎的 opening（§6、§10.6 的前置步骤）。
//
// 引擎的 opening 需要 9 个字段（players / wall / flipTiles / jokers / headDrawn / dealerDrawnIndex /
// flipStack / flipSeat / wallBreakIndex），缺任何一项都无法重建开局。这里**绝不**用默认值顶替缺失字段：
// 缺了就明确报「复现数据不完整」，否则重跑出来的是另一个局面，校验器却会报「一致」。
import { SEATS } from '../../variants/lotus/bloodFlow/state'
import type { BloodFlowOpeningState } from '../../variants/lotus/bloodFlow/state'
import type { GamePlayer, Meld, TileType } from '../../core/contracts/types'
import { TILE_TYPES } from '../../core/rules/tiles'
import type { AnalysisReproduction } from './types'

/** 牌名 → 牌型；未知牌名直接抛错（不静默跳过，避免悄悄改变开局）。 */
export function tileFromName(name: string): TileType {
  const found = TILE_TYPES.find(tile => tile === name)
  if (!found) throw new Error(`未知牌名：${name}`)
  return found
}

export interface ReproductionOpeningResult {
  opening: BloodFlowOpeningState | null
  /** 无法还原的原因；null 表示成功。 */
  reason: string | null
}

export interface ReproductionOpeningOptions {
  /** 开局分数：不参与牌流，只影响计分显示；记录里带了就用记录的。 */
  baseScores?: readonly number[]
  playerNames?: readonly string[]
}

/**
 * 重建引擎开局。
 * `headDrawn` 由牌墙长度推出：一副 136 张、翻精墩移出 2 张（134 张进入牌墙环），
 * 因此 headDrawn = 134 - 剩余牌墙长度（与引擎测试的构造口径一致）。
 */
export function openingFromReproduction(
  record: AnalysisReproduction,
  options: ReproductionOpeningOptions = {},
): ReproductionOpeningResult {
  const missing: string[] = []
  if (!record.initialWall?.length) missing.push('initialWall')
  if (!record.initialHands || record.initialHands.length !== 4) missing.push('initialHands(四家)')
  if (typeof record.dealer !== 'number') missing.push('dealer')
  if (typeof record.dealerDrawnIndex !== 'number') missing.push('dealerDrawnIndex')
  if (!record.flipTiles || record.flipTiles.length !== 2) missing.push('flipTiles(两个翻精)')
  if (!record.jokers?.length) missing.push('jokers')
  if (typeof record.flipStack !== 'number') missing.push('flipStack')
  if (typeof record.flipSeat !== 'number') missing.push('flipSeat')
  if (typeof record.wallBreakIndex !== 'number') missing.push('wallBreakIndex')
  if (missing.length) return { opening: null, reason: `复现数据不完整，缺少：${missing.join('、')}` }

  try {
    const recordedScores = (record as { openingScores?: number[] }).openingScores
    const scores = options.baseScores ?? recordedScores ?? [2000, 2000, 2000, 2000]
    const players = SEATS.map((seat): GamePlayer => ({
      seat,
      name: options.playerNames?.[seat] ?? `P${seat}`,
      avatar: '',
      score: scores[seat] ?? 2000,
      hand: record.initialHands![seat].map(tileFromName),
      melds: [] as Meld[],
      discards: [],
      redCount: 0,
      drawnTileIndex: -1,
    }))
    const wall = record.initialWall!.map(tileFromName)
    return {
      opening: {
        players,
        wall,
        flipTiles: [tileFromName(record.flipTiles![0]), tileFromName(record.flipTiles![1])] as [TileType, TileType],
        jokers: record.jokers!.map(tileFromName),
        headDrawn: 134 - wall.length,
        dealerDrawnIndex: record.dealerDrawnIndex!,
        flipStack: record.flipStack!,
        flipSeat: record.flipSeat!,
        wallBreakIndex: record.wallBreakIndex!,
      },
      reason: null,
    }
  } catch (error) {
    return { opening: null, reason: `复现数据无法还原成开局：${String(error).slice(0, 120)}` }
  }
}
