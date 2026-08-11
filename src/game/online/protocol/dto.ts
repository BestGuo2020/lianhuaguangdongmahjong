import type { Announcement, LastDiscard, RoundResult } from '../../core/gamePort'
import type { GamePlayer, MatchType, TileType, WinPresentation } from '../../core/types'

export interface ServerSnapshot {
  kind: 'state_snapshot'
  roomId: string
  mode: MatchType
  phase: string
  round: number
  dealer: number
  honba: number
  dice?: [number, number]
  wallCount: number
  wall: TileType[]
  headDrawn: number
  currentPlayer: number
  players: GamePlayer[]
  seat: number
  result: RoundResult | null
  announcement: Announcement | null
  matchFinished: boolean
  lastDiscard: LastDiscard | null
  winPresentation: WinPresentation | null
  winningPlayerIndex: number
}
