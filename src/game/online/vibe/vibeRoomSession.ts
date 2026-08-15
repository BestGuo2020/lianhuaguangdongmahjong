// SDK 房间生命周期胶水（Phase 1）：把 vibeRoom（建房/加房）+ vibeLobby（座位/准备/开局）
// 粘合到联机状态，替代 remoteRoomLifecycle 的 REST 生命周期。
//
// - createRoom / joinRoom → vibeRoom，之后按 isHost 分别建立 createHostLobby / createClientLobby
// - toggleReady / startMatch → 走大厅协议（房主收集准备态、全员就绪后广播 lobby_start）
// - leaveRoom / closeRoom → room.leave() / room.close()
// - getRoom() 暴露已加入的 SDK Room，供 vibeRoomTransport（Phase 2）在 join 后创建传输层
import type { Ref } from 'vue'
import type { MatchType } from '../../core/contracts/types'
import type { RuleVariant } from '../../core/rules/ruleVariants'
import { createRoom as createVibeRoom, getRoomMeta, joinRoom as joinVibeRoom } from './vibeRoom'
import { createClientLobby, createHostLobby, type LobbySeat } from './vibeLobby'

export interface VibeRoomSessionState {
  roomId: Ref<string>
  mySeat: Ref<number>
  nickname: Ref<string>
  avatar: Ref<string>
  playerId: Ref<string>
  roomSeats: Ref<LobbySeat[]>
  sessionStatus: Ref<string>
  sessionError: Ref<string>
  rulesetId: Ref<RuleVariant>
  matchType: Ref<MatchType>
  isHost: Ref<boolean>
}

export interface VibeRoomSessionOptions {
  state: VibeRoomSessionState
  /** 全员就绪并开局后的回调（房主/客户端都会收到 lobby_start）。 */
  onStart: (room: VibeHubSDK.Room) => void
  /** 房主关闭房间时的回调（客户端收到 lobby_closed）。 */
  onClosed: () => void
}

const ERROR_TEXT: Record<string, string> = {
  ROOM_FULL: '房间已满',
  ALREADY_IN_ROOM: '你已在房间中，请先离开当前房间',
}

function readableError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return ERROR_TEXT[error.message] ?? error.message
}

export function createVibeRoomSession({ state, onStart, onClosed }: VibeRoomSessionOptions) {
  let room: VibeHubSDK.Room | null = null
  let hostLobby: ReturnType<typeof createHostLobby> | null = null
  let clientLobby: ReturnType<typeof createClientLobby> | null = null

  function ownSeat(): LobbySeat | undefined {
    if (!room) return undefined
    return state.roomSeats.value.find((seat) => seat.peerId === room!.peerId)
  }

  function clearSession() {
    // 客户端主动离开时先通知房主释放座位（比依赖 SDK 断连检测更可靠、更即时）。
    if (!state.isHost.value) clientLobby?.leave()
    room?.leave()
    room = null
    hostLobby = null
    clientLobby = null
    state.roomId.value = ''
    state.mySeat.value = -1
    state.roomSeats.value = []
    state.isHost.value = false
    state.sessionStatus.value = 'idle'
  }

  async function createRoom(mode: MatchType, capacity: number, rulesetId: RuleVariant) {
    state.sessionError.value = ''
    state.sessionStatus.value = 'creating'
    try {
      const created = await createVibeRoom({ mode, rulesetId, capacity })
      room = created
      state.isHost.value = true
      state.roomId.value = created.roomId
      state.mySeat.value = 0
      state.matchType.value = mode
      state.rulesetId.value = rulesetId
      state.roomSeats.value = [{ seat: 0, peerId: created.peerId, nickname: state.nickname.value, avatar: state.avatar.value, ready: false }]
      hostLobby = createHostLobby({
        room: created,
        capacity,
        hostNickname: state.nickname.value,
        hostAvatar: state.avatar.value,
        onRoster: (seats) => { state.roomSeats.value = seats },
        onStart: () => onStart(created),
      })
      state.sessionStatus.value = 'connected'
    } catch (error) {
      state.sessionError.value = readableError(error, '创建房间失败')
      state.sessionStatus.value = 'idle'
      throw error
    }
  }

  async function joinRoom(code: string) {
    state.sessionError.value = ''
    state.sessionStatus.value = 'joining'
    try {
      const joined = await joinVibeRoom(code)
      room = joined
      state.isHost.value = false
      state.roomId.value = joined.roomId
      const meta = await getRoomMeta(joined.roomId)
      if (meta) {
        if (meta.mode === 'east' || meta.mode === 'hanchan') state.matchType.value = meta.mode
        if (meta.rulesetId === 'lotus-classic' || meta.rulesetId === 'lotus-legacy') state.rulesetId.value = meta.rulesetId
      }
      clientLobby = createClientLobby({
        room: joined,
        onRoster: (_hostSeat, seats) => {
          state.roomSeats.value = seats
          const own = seats.find((seat) => seat.peerId === joined.peerId)
          if (own) state.mySeat.value = own.seat
        },
        onStart: () => onStart(joined),
        onClosed: () => onClosed(),
      })
      clientLobby.hello(state.nickname.value, state.avatar.value)
      state.sessionStatus.value = 'connected'
    } catch (error) {
      state.sessionError.value = readableError(error, '加入房间失败')
      state.sessionStatus.value = 'idle'
      throw error
    }
  }

  async function toggleReady(): Promise<void> {
    if (!room) return
    const own = ownSeat()
    const next = !(own?.ready ?? false)
    if (state.isHost.value) hostLobby?.setHostReady(next)
    else clientLobby?.setReady(next)
  }

  async function startMatch(): Promise<void> {
    if (state.isHost.value) hostLobby?.requestStart()
  }

  async function leaveRoom(): Promise<void> {
    clearSession()
  }

  async function closeRoom(): Promise<void> {
    if (state.isHost.value) hostLobby?.close()
    clearSession()
  }

  async function resumeSession(): Promise<void> {
    // SDK 无「继续对局」概念（无 localStorage 重连），保留空实现对齐 RemoteLobbyActions。
  }

  return {
    createRoom,
    joinRoom,
    toggleReady,
    startMatch,
    leaveRoom,
    closeRoom,
    resumeSession,
    getRoom: () => room,
  }
}
