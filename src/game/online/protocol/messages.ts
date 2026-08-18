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

export interface RoundStartMessage {
  kind: 'round_start'
  /** 房间绑定；旧 Room 的迟到开局事件不能污染当前会话。 */
  roomId?: string
  /** 房主引擎会话代次；旧房主/旧 Room 的开局消息不能复活当前牌局。 */
  authorityEpoch?: string
  /** 当前房主生命周期内单调递增的开局事件序号；迟到/重复开局不能重置客户端状态。 */
  sequence?: number
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
  | { kind: 'turn_request'; authorityEpoch?: string; round?: number; requestId?: string; requestSeq?: number; targetSeat?: number; ctx: { hand: TileType[]; melds: ServerMeldDto[]; exposedMelds: number; kongBloom: boolean; skipDraw: boolean; afterKong: boolean; jokers?: TileType[]; canHu?: boolean; canWindKong?: boolean } }
  | { kind: 'claim_request'; authorityEpoch?: string; round?: number; requestId?: string; requestSeq?: number; targetSeat?: number; ctx: { hand: TileType[]; canPeng?: boolean; canHu?: boolean; canGang: boolean; chiOptions?: Array<{ tiles: TileType[]; kind: 'sequence' | 'wind' | 'dragon' }>; tile: TileType; from: number } }
  | { kind: 'rob_kong_request'; authorityEpoch?: string; round?: number; requestId?: string; requestSeq?: number; targetSeat?: number; ctx: { tile: TileType; from: number; hand: TileType[]; exposedMelds: number } }

export type ServerMessage =
  | ServerSnapshot
  | ServerRequest
  | RoundStartMessage
  | { kind: 'rejoin_ok'; seat: number; rejoin: boolean; roomId: string; mode: MatchType; rulesetId?: RuleVariant; nickname: string; rejoinCode: string; authorityEpoch?: string }
  | { kind: 'rejoin_err'; code: string }
  | { kind: 'table_action'; event: TableActionEvent; authorityEpoch?: string; round?: number }
  | { kind: 'score_flow'; deltas: ScoreDelta[]; authorityEpoch?: string; round?: number }
  | { kind: 'announcement'; text: string; tone: string; id?: number; authorityEpoch?: string; round?: number }
  | { kind: 'hand_result'; result: RoundResult; authorityEpoch?: string; round?: number }
  | { kind: 'continue_prompt'; total: number }
  | { kind: 'match_finished'; roomId: string; mode: MatchType; rulesetId?: RuleVariant; finalScores: Array<{ seat: number; name: string; score: number }>; authorityEpoch?: string; sequence?: number; round?: number }
  | { kind: 'room_closed' }
  | { kind: 'pong' }
  | { kind: 'error'; code: string }
