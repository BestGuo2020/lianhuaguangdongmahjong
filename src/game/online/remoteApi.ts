// 远程房间 REST 客户端 —— 对应 backend/app/api/rooms.py 的 6 个路由
// 由 useRemoteGame 调用，与 WebSocket 实时通道分离（REST 管生命周期，WS 管对局）。
import type { MatchType } from '../core/types'

export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

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
  seats: Array<RoomSeatState | null>
}

export interface JoinResult {
  roomId: string
  seat: number
  nickname: string
  rejoinCode: string
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

export function joinRoom(roomId: string, nickname: string): Promise<JoinResult> {
  return request<JoinResult>(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    body: JSON.stringify({ nickname }),
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
