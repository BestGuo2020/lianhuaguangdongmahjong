import type { MatchType } from '../../core/types'
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

export interface CloseResult {
  roomId: string
  closed: boolean
}

export interface RoomMeta {
  active: number
  max: number
}

export function createRoom(mode: MatchType, capacity: number, playerId?: string): Promise<RoomInfo> {
  return request<RoomInfo>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ mode, capacity, playerId }),
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

export function startRoom(roomId: string): Promise<StartResult> {
  return request<StartResult>(`/api/rooms/${encodeURIComponent(roomId)}/start`, {
    method: 'POST',
    body: '{}',
  })
}

export function closeRoom(roomId: string, seat: number, rejoinCode: string): Promise<CloseResult> {
  return request<CloseResult>(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ seat, rejoinCode }),
  })
}
