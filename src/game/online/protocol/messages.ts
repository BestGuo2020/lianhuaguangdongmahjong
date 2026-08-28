import type { RoundResult } from '../../core/contracts/gamePort'
import type {
  MatchType,
  ScoreDelta,
  TableActionEvent,
  TileType,
} from '../../core/contracts/types'
import type { ServerSnapshot } from './dto'
import type { ServerMeldDto } from './dto'
import type { RuleVariant } from '../../core/rules/ruleVariants'
import type { LlmSpeechPriority } from '../../llm/speechPolicy'

export interface RoundStartMessage {
  kind: 'round_start'
  matchStarted: boolean
  round: number
  dealer: number
  honba: number
  dice: [number, number]
  secondDice?: [number, number]
  flipTile?: TileType
  flipStack?: number
  flipSeat?: number
}

export type ServerRequest =
  | { kind: 'turn_request'; ctx: { hand: TileType[]; melds: ServerMeldDto[]; exposedMelds: number; kongBloom: boolean; skipDraw: boolean; afterKong: boolean; jokers?: TileType[]; canHu?: boolean; canWindKong?: boolean } }
  | { kind: 'claim_request'; ctx: { hand: TileType[]; canPeng?: boolean; canHu?: boolean; canGang: boolean; chiOptions?: Array<{ tiles: TileType[]; kind: 'sequence' | 'wind' | 'dragon' }>; tile: TileType; from: number } }
  | { kind: 'rob_kong_request'; ctx: { tile: TileType; from: number; hand: TileType[]; exposedMelds: number } }

export type ServerMessage =
  | ServerSnapshot
  | ServerRequest
  | RoundStartMessage
  | { kind: 'rejoin_ok'; seat: number; rejoin: boolean; roomId: string; mode: MatchType; rulesetId?: RuleVariant; nickname: string; rejoinCode: string }
  | { kind: 'rejoin_err'; code: string }
  | { kind: 'table_action'; event: TableActionEvent }
  | { kind: 'score_flow'; deltas: ScoreDelta[] }
  | { kind: 'announcement'; text: string; tone: string; id?: number }
  | { kind: 'llm_message'; seat: number; text: string; id: number; priority?: LlmSpeechPriority }
  | { kind: 'llm_status'; seat: number; active: boolean }
  | { kind: 'llm_audio'; messageId: number; seat: number; audioUrl: string; cached: boolean; priority?: LlmSpeechPriority }
  | { kind: 'hand_result'; result: RoundResult }
  | { kind: 'continue_prompt'; total: number }
  | { kind: 'match_finished'; roomId: string; mode: MatchType; rulesetId?: RuleVariant; finalScores: Array<{ seat: number; name: string; score: number }> }
  | { kind: 'room_closed' }
  | { kind: 'pong' }
  | { kind: 'error'; code: string }
