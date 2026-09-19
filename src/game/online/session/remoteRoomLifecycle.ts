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
  reserveLlmSeat,
  startRoom,
  updateCharacter,
  type LlmSeatRequest,
  type RoomSeatState,
  type ServerLlmStyle,
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
  /** 房主预留的空位（大模型专属，真人不可加入）；其余空位「自动选择」= 真人可占。 */
  reservedSeats: Ref<Array<LlmSeatRequest>>
  roomTimeLimit: Ref<number | null>
  /** 服务端房间状态：playing + 本家在房间面板 ⇒ 本家已暂离牌桌（可「回到牌桌」）。 */
  roomStatus: Ref<'lobby' | 'playing' | 'finished' | 'error' | 'closed'>
  /** 房主请求的空座 AI 补位是否使用大模型（llmEnabled） */
  llmEnabled: Ref<boolean>
  /** 实际生效（请求 && 服务端配置齐全） */
  effectiveLlmEnabled: Ref<boolean>
  /** 服务端是否配置了大模型 */
  llmAvailable: Ref<boolean>
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
  updateCharacter: typeof updateCharacter
  reserveLlmSeat: typeof reserveLlmSeat
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
  getCharacterId?(): string
  api?: RemoteRoomApi
  pollInterval?: number
}

const DEFAULT_API: RemoteRoomApi = {
  createRoom, getRoom, joinRoom, updateCharacter, reserveLlmSeat, leaveRoom, readyRoom,
  startRoom, closeRoom,
}

const REMOTE_ERROR_TEXT: Record<string, string> = {
  ROOM_LIMIT_REACHED: '房间已满',
  ROOM_FULL: '房间已满',
  ALREADY_IN_ROOM: '你已在房间中，请先离开当前房间',
  SEATS_RESERVED: '房主已把剩余空位预留给大模型，请让房主改回「自动选择」或换一间房',
  SEAT_OCCUPIED: '该座位已有真人，不能预留给大模型',
  INVALID_SEAT: '座位号无效',
  NOT_CREATOR: '只有房主能设置大模型预留',
  LLM_NOT_ENABLED: '本房间未启用大模型补位',
  INVALID_LLM_SEATS: '该模型当前不可用，请让房主改选其他模型',
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
  getCharacterId = () => 'deepseek',
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
      state.reservedSeats.value = info.reservedSeats ?? []
      state.creatorSeat.value = info.creatorSeat ?? null
      state.isCreator.value = state.creatorSeat.value != null
        && state.mySeat.value === state.creatorSeat.value
      state.roomTimeLimit.value = info.timeLimitSeconds ?? null
      state.roomStatus.value = info.status
      state.llmEnabled.value = info.llmEnabled === true
      state.effectiveLlmEnabled.value = info.effectiveLlmEnabled === true
      state.llmAvailable.value = info.llmAvailable === true
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
    state.reservedSeats.value = []
    state.roomStatus.value = 'lobby'
    state.llmEnabled.value = false
    state.effectiveLlmEnabled.value = false
    state.llmAvailable.value = false
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
    rulesetId: RuleVariant = state.rulesetId.value, llmEnabled?: boolean) {
    state.sessionError.value = ''
    state.sessionStatus.value = 'creating'
    try {
      const info = await api.createRoom(mode, capacity, state.playerId.value, rulesetId, llmEnabled)
      state.rulesetId.value = info.rulesetId ?? 'lotus-classic'
      state.isCreator.value = true
      state.roomTimeLimit.value = info.timeLimitSeconds ?? null
      state.llmEnabled.value = info.llmEnabled === true
      state.effectiveLlmEnabled.value = info.effectiveLlmEnabled === true
      state.llmAvailable.value = info.llmAvailable === true
      ensurePlayerId()
      const joined = await api.joinRoom(info.roomId, state.nickname.value, state.playerId.value, getCharacterId())
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
      const joined = await api.joinRoom(code.trim().toUpperCase(), state.nickname.value, state.playerId.value, getCharacterId())
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

  async function updateCharacter(characterId: string) {
    if (!state.roomId.value || state.mySeat.value < 0 || !state.rejoinCode.value) return
    try {
      await api.updateCharacter(state.roomId.value, state.mySeat.value, state.rejoinCode.value, characterId)
      await refreshRoom()
    } catch (error) {
      state.sessionError.value = readableError(error, '更新角色失败')
    }
  }

  async function startMatch(llmSeats?: Array<LlmSeatRequest>) {
    if (!state.roomId.value) return
    try {
      await api.startRoom(state.roomId.value, llmSeats)
    } catch (error) {
      state.sessionError.value = readableError(error, '开局失败')
      throw error
    }
  }

  /**
   * 房主为某个空位写 / 清大模型预留：`providerId` 为空 = 取消预留（改回「自动选择」）。
   *
   * 预留写在服务端房间上：别人 join 时据此跳过该座，房主刷新/换设备也不丢；
   * 失败时回读房间真值，面板（值由 reservedSeats 驱动）不会停在错误选项上。
   */
  async function reserveLlmSeat(reserveSeat: number, providerId: string | null,
    style: ServerLlmStyle | null) {
    if (!state.roomId.value || state.mySeat.value < 0 || !state.rejoinCode.value) return
    state.sessionError.value = ''
    try {
      const result = await api.reserveLlmSeat(
        state.roomId.value, state.mySeat.value, state.rejoinCode.value,
        reserveSeat, providerId, style)
      state.reservedSeats.value = result.reservedSeats ?? []
    } catch (error) {
      state.sessionError.value = readableError(error, '设置大模型预留失败')
      await refreshRoom()
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

  /**
   * 暂离（牌桌「返回大厅」）：**不退出房间**——保留座位、重进码与会话，只停止轮询并断开
   * 连接（服务端按断线 AI 托管、且不再计入待决策与结算屏障），本机停在房间面板；
   * 面板据此显示「本场进行中 · 你在暂离」并可「回到牌桌」（重连恢复原座位）。
   */
  function stepOutToLobby() {
    stopPolling()
    closeConnection()
    resetGame()
    state.phase.value = 'lobby'
    state.matchFinished.value = false
    state.sessionStatus.value = 'connected'
    void refreshRoom()
    startPolling()
  }

  /**
   * 退出本场：回主大厅，**保留座位与会话**（不 REST leave）——座位交服务端 AI 打完本场，
   * 大厅显示「继续对局（房间 X）」，可随时重进原座位（走 WS 重进握手）。
   */
  function leaveMatch() {
    stopPolling()
    closeConnection()
    resetGame()
    state.phase.value = 'lobby'
    state.matchFinished.value = false
    state.sessionStatus.value = 'idle'
    state.roomId.value = ''
    state.rejoinCode.value = ''
    state.mySeat.value = -1
    state.creatorSeat.value = null
    state.isCreator.value = false
    state.roomSeats.value = []
    state.reservedSeats.value = []
    state.roomStatus.value = 'lobby'
    // storedSession（含 rejoinCode）保留：大厅据它显示「继续对局」，重进即恢复原座位。
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
    updateCharacter,
    reserveLlmSeat,
    startMatch,
    leaveRoom: leaveRemoteRoom,
    closeRoom: closeRemoteRoom,
    stepOutToLobby,
    leaveMatch,
    resumeSession,
    refreshRoom,
    clearSession,
    stopPolling,
  }
}
