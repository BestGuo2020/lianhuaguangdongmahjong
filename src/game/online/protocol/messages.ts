import type { RoundResult } from '../../core/contracts/gamePort'
import type {
  MatchType,
  Meld,
  ScoreDelta,
  TableActionEvent,
  TileType,
} from '../../core/contracts/types'
import type { ServerSnapshot } from './dto'

export interface RoundStartMessage {
  kind: 'round_start'
  matchStarted: boolean
  round: number
  dealer: number
  honba: number
  dice: [number, number]
}

export type ServerRequest =
  | { kind: 'turn_request'; ctx: { hand: TileType[]; melds: Meld[]; exposedMelds: number; kongBloom: boolean; skipDraw: boolean; afterKong: boolean } }
  | { kind: 'claim_request'; ctx: { hand: TileType[]; canGang: boolean; tile: TileType; from: number } }
  | { kind: 'rob_kong_request'; ctx: { tile: TileType; from: number; hand: TileType[]; exposedMelds: number } }

export type ServerMessage =
  | ServerSnapshot
  | ServerRequest
  | RoundStartMessage
  | { kind: 'rejoin_ok'; seat: number; rejoin: boolean; roomId: string; mode: MatchType; nickname: string; rejoinCode: string }
  | { kind: 'rejoin_err'; code: string }
  | { kind: 'table_action'; event: TableActionEvent }
  | { kind: 'score_flow'; deltas: ScoreDelta[] }
  | { kind: 'announcement'; text: string; tone: string; id?: number }
  | { kind: 'hand_result'; result: RoundResult }
  | { kind: 'continue_prompt'; total: number }
  | { kind: 'match_finished'; roomId: string; mode: MatchType; finalScores: Array<{ seat: number; name: string; score: number }> }
  | { kind: 'room_closed' }
  | { kind: 'pong' }
  | { kind: 'error'; code: string }
