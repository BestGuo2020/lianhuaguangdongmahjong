import type { Announcement, GamePhase, LastDiscard, RoundResult } from '../../core/contracts/gamePort'
import type { GamePlayer, MatchType, TileType, WinPresentation } from '../../core/contracts/types'

export interface ServerSnapshot {
  kind: 'state_snapshot'
  roomId: string
  mode: MatchType
  phase: GamePhase
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
