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
  revealHands?: boolean
  winnerIndex?: number
  winEffect?: WinEffect | null
  winPresentation?: WinPresentation | null
  dealAnimation?: DealAnimation
  openingStage?: OpeningStage | null
  diceValues?: number[]
  dealerIndex?: number
  tableActionEvent?: TableActionEvent | null
}

export type ResolvedTableProps = {
  [K in keyof Required<TableProps>]: Exclude<Required<TableProps>[K], undefined>
}

export interface TableTransform {
  x: number
  z: number
  rotation: number
}
