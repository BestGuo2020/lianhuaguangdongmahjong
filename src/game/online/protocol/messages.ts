import type { RoundResult } from '../../core/contracts/gamePort'
import type {
  MatchType,
  ScoreDelta,
  TableActionEvent,
  TileType,
  WinPresentation,
} from '../../core/contracts/types'
import type { ServerSnapshot } from './dto'
import type { ServerMeldDto, ServerPlayerDto } from './dto'
import type { RuleVariant } from '../../core/rules/ruleVariants'
import type { LlmStyle, LlmTtsVoiceKey } from '../../llm/config'
import type { LlmSpeechPriority } from '../../llm/speechPolicy'

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

/**
 * 不含牌墙、但包含结算后四家公开手牌的房间级单局结算事实。
 *
 * 完整 state_snapshot 仍按座位定向发送；这条公共消息用于定向 peer 通道半开时
 * 让仍在当前 Room 的客户端进入同一份胡牌表现、亮牌和结算，避免房主永久等待确认。
 */
export interface RoundSettledMessage {
  kind: 'round_settled'
  roomId: string
  authorityEpoch: string
  sequence: number
  mode: MatchType
  rulesetId?: RuleVariant
  round: number
  honba: number
  dealer: number
  result: RoundResult
  winPresentation: WinPresentation | null
  winningPlayerIndex: number
  /** 结算阶段已公开的四家最终手牌；不得包含 null 暗牌占位。 */
  players: ServerPlayerDto[]
  scores: Array<{ seat: number; name: string; score: number }>
}

/** 房主胡牌表现开始时的小型公共事件；settled 快照/事实随后补齐最终分数。 */
export interface WinEffectMessage {
  kind: 'win_effect'
  roomId: string
  authorityEpoch: string
  sequence: number
  round: number
  honba: number
  winPresentation: WinPresentation
  winningPlayerIndex: number
}

/** 客户端在胡牌表现完成但结算事实缺失时发出的单次 P2P 补偿请求。 */
export interface SettlementSyncRequest {
  type: 'settlement_sync_request'
  authorityEpoch: string
  round: number
  honba: number
}

export type ServerRequest =
  | { kind: 'turn_request'; authorityEpoch?: string; round?: number; requestId?: string; requestSeq?: number; targetSeat?: number; ctx: { hand: TileType[]; melds: ServerMeldDto[]; exposedMelds: number; kongBloom: boolean; skipDraw: boolean; afterKong: boolean; jokers?: TileType[]; canHu?: boolean; canWindKong?: boolean } }
  | { kind: 'claim_request'; authorityEpoch?: string; round?: number; requestId?: string; requestSeq?: number; targetSeat?: number; ctx: { hand: TileType[]; canPeng?: boolean; canHu?: boolean; canGang: boolean; chiOptions?: Array<{ tiles: TileType[]; kind: 'sequence' | 'wind' | 'dragon' }>; tile: TileType; from: number } }
  | { kind: 'rob_kong_request'; authorityEpoch?: string; round?: number; requestId?: string; requestSeq?: number; targetSeat?: number; ctx: { tile: TileType; from: number; hand: TileType[]; exposedMelds: number } }

export type ServerMessage =
  | ServerSnapshot
  | ServerRequest
  | RoundStartMessage
  | WinEffectMessage
  | RoundSettledMessage
  | { kind: 'rejoin_ok'; seat: number; rejoin: boolean; roomId: string; mode: MatchType; rulesetId?: RuleVariant; nickname: string; rejoinCode: string; authorityEpoch?: string }
  | { kind: 'rejoin_err'; code: string }
  | { kind: 'table_action'; event: TableActionEvent; authorityEpoch?: string; round?: number }
  | { kind: 'score_flow'; deltas: ScoreDelta[]; authorityEpoch?: string; round?: number }
  | { kind: 'announcement'; text: string; tone: string; id?: number; authorityEpoch?: string; round?: number }
  | { kind: 'llm_message'; roomId: string; authorityEpoch: string; round: number; sequence: number; id: number; seat: number; text: string; style: LlmStyle; voiceKey: Exclude<LlmTtsVoiceKey, 'auto'>; priority?: LlmSpeechPriority }
  | { kind: 'hand_result'; result: RoundResult; authorityEpoch?: string; round?: number }
  | { kind: 'continue_prompt'; total: number }
  | { kind: 'match_finished'; roomId: string; mode: MatchType; rulesetId?: RuleVariant; finalScores: Array<{ seat: number; name: string; score: number }>; authorityEpoch?: string; sequence?: number; round?: number }
  | { kind: 'room_closed' }
  | { kind: 'pong' }
  | { kind: 'error'; code: string }
