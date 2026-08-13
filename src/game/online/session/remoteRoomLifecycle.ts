import { type Ref } from 'vue'
import type { GamePhase } from '../../core/contracts/gamePort'
import type { GamePlayer, MatchType } from '../../core/contracts/types'
import type { RuleVariant } from '../../core/rules/ruleVariants'
import {
  closeRoom,
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  readyRoom,
  startRoom,
  type RoomSeatState,
} from '../api/roomApi'
import { generateGuestId, type StoredSession } from './remoteSessionStore'

export type RemoteSessionStatus = 'idle' | 'creating' | 'joining' | 'connected' | 'readying' | 'playing'

export interface RemoteRoomState {
  sessionStatus: Ref<RemoteSessionStatus>
  sessionError: Ref<string>
  roomId: Ref<string>
  mySeat: Ref<number>
  nickname: Ref<string>
  rejoinCode: Ref<string>
  playerId: Ref<string>
  creatorSeat: Ref<number | null>
  isCreator: Ref<boolean>
  roomSeats: Ref<Array<RoomSeatState | null>>
  roomTimeLimit: Ref<number | null>
  rulesetId: Ref<RuleVariant>
  storedSession: Ref<StoredSession | null>
  phase: Ref<GamePhase>
  matchType: Ref<MatchType>
  matchFinished: Ref<boolean>
  players: GamePlayer[]
}

export interface RemoteRoomApi {
  createRoom: typeof createRoom
  getRoom: typeof getRoom
  joinRoom: typeof joinRoom
  leaveRoom: typeof leaveRoom
  readyRoom: typeof readyRoom
  startRoom: typeof startRoom
  closeRoom: typeof closeRoom
}

export interface RemoteRoomLifecycleOptions {
  state: RemoteRoomState
  sessionStore: {
    loadSession(): StoredSession | null
    saveSession(session: StoredSession): void
    clearSession(): void
    saveGuestId(playerId: string): void
    saveNickname(nickname: string): void
  }
  socket: { open(): void }
  closeConnection(): void
  resetGame(): void
  api?: RemoteRoomApi
  pollInterval?: number
}

const DEFAULT_API: RemoteRoomApi = {
  createRoom, getRoom, joinRoom, leaveRoom, readyRoom, startRoom, closeRoom,
}

const REMOTE_ERROR_TEXT: Record<string, string> = {
  ROOM_LIMIT_REACHED: '房间已满',
  ROOM_FULL: '房间已满',
  ALREADY_IN_ROOM: '你已在房间中，请先离开当前房间',
}

function readableError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return REMOTE_ERROR_TEXT[error.message] ?? error.message
}

export function createRemoteRoomLifecycle({
  state,
  sessionStore,
  socket,
  closeConnection,
  resetGame,
  api = DEFAULT_API,
  pollInterval = 1500,
}: RemoteRoomLifecycleOptions) {
  let pollTimer: number | null = null

  function ensurePlayerId() {
    if (state.playerId.value) return
    state.playerId.value = generateGuestId()
    sessionStore.saveGuestId(state.playerId.value)
  }

  function persistSession() {
    if (!state.roomId.value || !state.rejoinCode.value) return
    const session: StoredSession = {
      roomId: state.roomId.value,
      rejoinCode: state.rejoinCode.value,
      nickname: state.nickname.value,
      playerId: state.playerId.value,
      mode: state.matchType.value,
      rulesetId: state.rulesetId.value,
    }
    sessionStore.saveSession(session)
    state.storedSession.value = session
    if (state.nickname.value) sessionStore.saveNickname(state.nickname.value)
  }

  function stopPolling() {
    globalThis.clearInterval(pollTimer as number)
    pollTimer = null
  }

  async function refreshRoom() {
    if (!state.roomId.value || state.phase.value !== 'lobby') return
    try {
      const info = await api.getRoom(state.roomId.value)
      state.matchType.value = info.mode
      state.rulesetId.value = info.rulesetId ?? 'lotus-classic'
      state.roomSeats.value = info.seats ?? []
      state.creatorSeat.value = info.creatorSeat ?? null
      state.isCreator.value = state.creatorSeat.value != null
        && state.mySeat.value === state.creatorSeat.value
      state.roomTimeLimit.value = info.timeLimitSeconds ?? null
    } catch {
      // 轮询失败等待下一次刷新。
    }
  }

  function startPolling() {
    stopPolling()
    void refreshRoom()
    pollTimer = globalThis.setInterval(() => void refreshRoom(), pollInterval) as unknown as number
  }

  function clearSession() {
    sessionStore.clearSession()
    state.storedSession.value = null
    closeConnection()
    state.roomId.value = ''
    state.rejoinCode.value = ''
    state.mySeat.value = -1
    state.sessionStatus.value = 'idle'
    state.phase.value = 'lobby'
    state.roomSeats.value = []
  }

  async function enterRoom(id: string, name: string, mode: MatchType, code: string) {
    state.roomId.value = id
    state.matchType.value = mode
    state.rulesetId.value = state.rulesetId.value || 'lotus-classic'
    state.nickname.value = name
    state.rejoinCode.value = code
    state.mySeat.value = -1
    state.phase.value = 'lobby'
    state.matchFinished.value = false
    state.players.splice(0, state.players.length)
    state.sessionStatus.value = 'connected'
    startPolling()
    socket.open()
    persistSession()
  }

  async function resumeSession() {
    const session = state.storedSession.value ?? sessionStore.loadSession()
    if (!session?.rejoinCode) return
    state.sessionError.value = ''
    state.roomId.value = session.roomId
    state.rejoinCode.value = session.rejoinCode
    state.nickname.value = session.nickname
    state.playerId.value = session.playerId || state.playerId.value
    state.matchType.value = session.mode || 'east'
    state.rulesetId.value = session.rulesetId || 'lotus-classic'
    state.phase.value = 'lobby'
    state.matchFinished.value = false
    state.players.splice(0, state.players.length)
    state.sessionStatus.value = 'connected'
    startPolling()
    socket.open()
  }

  async function createRemoteRoom(mode: MatchType, capacity: number,
    rulesetId: RuleVariant = state.rulesetId.value) {
    state.sessionError.value = ''
    state.sessionStatus.value = 'creating'
    try {
      const info = await api.createRoom(mode, capacity, state.playerId.value, rulesetId)
      state.rulesetId.value = info.rulesetId ?? 'lotus-classic'
      state.isCreator.value = true
      state.roomTimeLimit.value = info.timeLimitSeconds ?? null
      ensurePlayerId()
      const joined = await api.joinRoom(info.roomId, state.nickname.value, state.playerId.value)
      await enterRoom(joined.roomId, joined.nickname, info.mode, joined.rejoinCode)
    } catch (error) {
      state.sessionError.value = readableError(error, '创建房间失败')
      state.sessionStatus.value = 'idle'
      throw error
    }
  }

  async function joinRemoteRoom(code: string) {
    state.sessionError.value = ''
    state.sessionStatus.value = 'joining'
    try {
      ensurePlayerId()
      const joined = await api.joinRoom(code.trim().toUpperCase(), state.nickname.value, state.playerId.value)
      const info = await api.getRoom(joined.roomId)
      state.isCreator.value = false
      await enterRoom(
        joined.roomId,
        joined.nickname,
        info.mode,
        joined.rejoinCode,
      )
    state.rulesetId.value = info.rulesetId ?? 'lotus-classic'
    } catch (error) {
      state.sessionError.value = readableError(error, '加入房间失败')
      state.sessionStatus.value = 'idle'
      throw error
    }
  }

  async function toggleReady() {
    if (!state.roomId.value || state.mySeat.value < 0 || state.sessionStatus.value === 'readying') return
    state.sessionStatus.value = 'readying'
    try {
      await api.readyRoom(state.roomId.value, state.mySeat.value, state.rejoinCode.value)
      await refreshRoom()
    } catch (error) {
      state.sessionError.value = readableError(error, '准备失败')
    } finally {
      if (state.roomId.value) state.sessionStatus.value = 'connected'
    }
  }

  async function startMatch() {
    if (!state.roomId.value) return
    try {
      await api.startRoom(state.roomId.value)
    } catch (error) {
      state.sessionError.value = readableError(error, '开局失败')
      throw error
    }
  }

  async function leaveRemoteRoom() {
    stopPolling()
    try {
      if (state.roomId.value && state.mySeat.value >= 0 && state.rejoinCode.value) {
        await api.leaveRoom(state.roomId.value, state.mySeat.value, state.rejoinCode.value)
      }
    } catch {
      // 房间已关闭或座位已释放时，本地仍继续清理。
    }
    clearSession()
    resetGame()
  }

  async function closeRemoteRoom() {
    if (!state.roomId.value || state.mySeat.value < 0 || !state.rejoinCode.value) return
    try {
      await api.closeRoom(state.roomId.value, state.mySeat.value, state.rejoinCode.value)
    } catch (error) {
      state.sessionError.value = readableError(error, '关闭房间失败')
      throw error
    }
    stopPolling()
    clearSession()
    resetGame()
  }

  ensurePlayerId()

  return {
    createRoom: createRemoteRoom,
    joinRoom: joinRemoteRoom,
    toggleReady,
    startMatch,
    leaveRoom: leaveRemoteRoom,
    closeRoom: closeRemoteRoom,
    resumeSession,
    refreshRoom,
    clearSession,
    stopPolling,
  }
}
