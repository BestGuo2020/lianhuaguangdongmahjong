import type { DealAnimation, LastDiscard, OpeningStage, WinEffect } from '../../../game/core/contracts/gamePort'
import type { GamePlayer, TableActionEvent, TileType, WinPresentation } from '../../../game/core/contracts/types'

export interface TableProps {
  players?: GamePlayer[]
  currentPlayer?: number
  lastDiscard?: LastDiscard | null
  wall?: TileType[]
  wallHeadDrawn?: number
  wallCount?: number
  horses?: TileType[]
  /** 本局精牌集合，用于 3D 牌面标记和亮牌排序。 */
  jokerTiles?: TileType[]
  revealHands?: boolean
  winnerIndex?: number
  winEffect?: WinEffect | null
  winPresentation?: WinPresentation | null
  dealAnimation?: DealAnimation
  openingStage?: OpeningStage | null
  diceValues?: number[]
  dealerIndex?: number
  diceThrowerIndex?: number
  tableActionEvent?: TableActionEvent | null
  /** 莲花麻将开局计算好的牌山断点；未传时回退按 diceValues 计算 */
  wallBreakIndex?: number
  /** 莲花麻将翻出的指示牌（精），需在牌山上翻出牌面 */
  flipTile?: TileType | null
  /** 翻精所在物理墩（0..67），指示牌在牌山上的位置 */
  flipStack?: number
}

export type ResolvedTableProps = {
  [K in keyof Required<TableProps>]: Exclude<Required<TableProps>[K], undefined>
}

export interface TableTransform {
  x: number
  z: number
  rotation: number
}
