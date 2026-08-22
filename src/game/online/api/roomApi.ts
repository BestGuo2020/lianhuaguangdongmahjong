import type { MatchType } from '../../core/contracts/types'
import type { RuleVariant } from '../../core/rules/ruleVariants'
import { request } from './httpClient'

export interface RoomSeatState {
  seat: number
  nickname: string
  ready: boolean
  connected: boolean
}

export interface RoomInfo {
  roomId: string
  mode: MatchType
  rulesetId?: RuleVariant
  capacity: number
  status: 'lobby' | 'playing' | 'finished' | 'error' | 'closed'
  creatorSeat: number | null
  timeLimitSeconds?: number
  /** 房主请求的空座 AI 补位是否使用大模型 */
  llmEnabled?: boolean
  /** 实际生效（房主请求 && 服务端配置齐全）；false = 空座由普通 AI 补位 */
  effectiveLlmEnabled?: boolean
  /** 服务端是否配置了大模型（llmAvailable） */
  llmAvailable?: boolean
  seats: Array<RoomSeatState | null>
}

export interface JoinResult {
  roomId: string
  seat: number
  nickname: string
  rejoinCode: string
  playerId: string | null
  rejoin: boolean
}

export interface ReadyResult {
  roomId: string
  seat: number
  ready: boolean
}

export interface LeaveResult {
  roomId: string
  seat: number
  left: boolean
}

export interface StartResult {
  roomId: string
  status: string
}

/** 每座位引用的服务端提供商（只带 id；key 全在服务端，不经过客户端） */
export interface LlmSeatRequest {
  seat: number
  providerId: string
}

/** 服务端提供商公开信息（不含 key），房主建房时按 id 选择 */
export interface LlmProviderInfo {
  id: string
  name: string
  model: string
  style: string
  nickname: string
  avatar: string
}

export interface CloseResult {
  roomId: string
  closed: boolean
}

export interface RoomMeta {
  active: number
  max: number
  /** 服务端是否配置了大模型（供大厅提示） */
  llmAvailable?: boolean
  /** 服务端注册的提供商（不含 key），房主建房时按 id 选择 */
  llmProviders?: Array<LlmProviderInfo>
}

export function createRoom(mode: MatchType, capacity: number, playerId?: string,
  rulesetId: RuleVariant = 'lotus-classic', llmEnabled?: boolean): Promise<RoomInfo> {
  return request<RoomInfo>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({
      mode, capacity, playerId, rulesetId,
      ...(llmEnabled === true ? { llmEnabled: true } : {}),
    }),
  })
}

export function getRoom(roomId: string): Promise<RoomInfo> {
  return request<RoomInfo>(`/api/rooms/${encodeURIComponent(roomId)}`)
}

export function getRoomMeta(): Promise<RoomMeta> {
  return request<RoomMeta>('/api/rooms/meta')
}

export function joinRoom(roomId: string, nickname: string, playerId?: string): Promise<JoinResult> {
  return request<JoinResult>(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    body: JSON.stringify({ nickname, playerId }),
  })
}

export function leaveRoom(roomId: string, seat: number, rejoinCode: string): Promise<LeaveResult> {
  return request<LeaveResult>(`/api/rooms/${encodeURIComponent(roomId)}/leave`, {
    method: 'POST',
    body: JSON.stringify({ seat, rejoinCode }),
  })
}

export function readyRoom(
  roomId: string,
  seat: number,
  rejoinCode: string,
  ready?: boolean,
): Promise<ReadyResult> {
  return request<ReadyResult>(`/api/rooms/${encodeURIComponent(roomId)}/ready`, {
    method: 'POST',
    body: JSON.stringify({ seat, rejoinCode, ready }),
  })
}

export function startRoom(roomId: string, llmSeats?: Array<LlmSeatRequest>): Promise<StartResult> {
  return request<StartResult>(`/api/rooms/${encodeURIComponent(roomId)}/start`, {
    method: 'POST',
    body: JSON.stringify(llmSeats && llmSeats.length ? { llmSeats } : {}),
  })
}

export function closeRoom(roomId: string, seat: number, rejoinCode: string): Promise<CloseResult> {
  return request<CloseResult>(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ seat, rejoinCode }),
  })
}
