// 远程房间 REST 客户端 —— 对应 backend/app/api/rooms.py 的 6 个路由
// 由 useRemoteGame 调用，与 WebSocket 实时通道分离（REST 管生命周期，WS 管对局）。
import type { MatchType } from '../core/types'

// 默认指向「页面所在主机」的 8000 端口（部署到局域网/同源时 API 与页面同 host）；
// 非浏览器环境（vitest）无 location，回退 localhost。
const API_HOST = typeof location !== 'undefined' ? location.host : 'localhost'
export const API_BASE = import.meta.env.VITE_API_BASE || `http://${API_HOST}`

// ─── 请求/响应类型（与后端 Pydantic 模型对应）─────────────

export interface RoomSeatState {
  seat: number
  nickname: string
  ready: boolean
  connected: boolean
}

export interface RoomInfo {
  roomId: string
  mode: MatchType
  capacity: number
  status: 'lobby' | 'playing' | 'finished' | 'error' | 'closed'
  creatorSeat: number | null
  timeLimitSeconds?: number
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

// ─── 错误 ─────────────────────────────────────────────────

export class RemoteApiError extends Error {
  code: string
  status: number

  constructor(code: string, status: number) {
    super(code)
    this.name = 'RemoteApiError'
    this.code = code
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    let code = `HTTP_${response.status}`
    try {
      const body = await response.json()
      if (body?.detail?.code) code = body.detail.code
    } catch {
      // 非 JSON 错误体，保留 HTTP 状态码
    }
    throw new RemoteApiError(code, response.status)
  }
  return response.json() as Promise<T>
}

// ─── 路由 ─────────────────────────────────────────────────

export function createRoom(mode: MatchType, capacity: number): Promise<RoomInfo> {
  return request<RoomInfo>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ mode, capacity }),
  })
}

export function getRoom(roomId: string): Promise<RoomInfo> {
  return request<RoomInfo>(`/api/rooms/${encodeURIComponent(roomId)}`)
}

export interface RoomMeta {
  active: number   // 当前在册房间数
  max: number      // 服务器房间上限
}

/** 服务器房间容量（大厅展示「剩余房间」用）。 */
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

export function startRoom(roomId: string): Promise<StartResult> {
  return request<StartResult>(`/api/rooms/${encodeURIComponent(roomId)}/start`, {
    method: 'POST',
    body: '{}',
  })
}

export interface CloseResult {
  roomId: string
  closed: boolean
}

export function closeRoom(roomId: string, seat: number, rejoinCode: string): Promise<CloseResult> {
  return request<CloseResult>(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ seat, rejoinCode }),
  })
}

export interface PlayerStats {
  nickname?: string
  playerId?: string
  matches: number
  hands: number
  wins: number
  totalDelta: number
}

export function getPlayerStats(nickname: string): Promise<PlayerStats> {
  return request<PlayerStats>(`/api/players/${encodeURIComponent(nickname)}/stats`)
}

/** 按匿名身份（guestId / player_id）查战绩：改名不丢历史、重名不混。 */
export function getPlayerStatsById(playerId: string): Promise<PlayerStats> {
  return request<PlayerStats>(`/api/players/by-id/${encodeURIComponent(playerId)}/stats`)
}

export interface ReportRequest {
  roomId?: string
  reporterPlayerId: string
  targetPlayerId?: string
  targetName?: string
  reason?: string
}

export function reportPlayer(body: ReportRequest): Promise<{ reported: boolean }> {
  return request<{ reported: boolean }>('/api/reports', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
