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
import { createClientLobby, createHostLobby, type LobbyStartDetails, type LobbySeat } from './vibeLobby'
import type { PublicAiSeat } from './vibeLlm'
import type { TableThemeName } from '../../../components/table/three/tableTheme'
import { isTableThemeName } from '../../../components/table/three/tableThemePreference'

export interface VibeRoomSessionState {
  roomId: Ref<string>
  mySeat: Ref<number>
  nickname: Ref<string>
  avatar: Ref<string>
  playerId: Ref<string>
  roomSeats: Ref<LobbySeat[]>
  aiSeats: Ref<PublicAiSeat[]>
  sessionStatus: Ref<string>
  sessionError: Ref<string>
  rulesetId: Ref<RuleVariant>
  matchType: Ref<MatchType>
  isHost: Ref<boolean>
  tableThemeName: Ref<TableThemeName>
  /** 对局相位（'lobby' = 大厅；其余 = 对局中），供 hostLobby 判定掉线座位是否可释放。 */
  phase: Ref<string>
}

export interface VibeRoomSessionOptions {
  state: VibeRoomSessionState
  /** 全员就绪并开局后的回调（房主/客户端都会收到 lobby_start）。 */
  onStart: (room: VibeHubSDK.Room, details: LobbyStartDetails) => void
  /** 房主关闭房间时的回调（客户端收到 lobby_closed）。 */
  onClosed: () => void
  /** 客户端收到房主定向签发的座位续接凭据。 */
  onSeatToken?: (token: string) => void
  /** 上次的会话（刷新页面重进用）；返回 null 表示无会话。 */
  loadSavedRoom?: () => { roomId: string; nickname?: string; seatToken?: string } | null
}

const ERROR_TEXT: Record<string, string> = {
  ROOM_FULL: '房间已满',
  ALREADY_IN_ROOM: '你已在房间中，请先离开当前房间',
}

function readableError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return ERROR_TEXT[error.message] ?? error.message
}

export function createVibeRoomSession({ state, onStart, onClosed, onSeatToken, loadSavedRoom }: VibeRoomSessionOptions) {
  let room: VibeHubSDK.Room | null = null
  let hostLobby: ReturnType<typeof createHostLobby> | null = null
  let clientLobby: ReturnType<typeof createClientLobby> | null = null

  function ownSeat(): LobbySeat | undefined {
    if (!room) return undefined
    return state.roomSeats.value.find((seat) => seat.peerId === room!.peerId)
  }

  function clearSession() {
    const oldRoom = room
    // 先切断当前引用，再让 SDK 收尾。旧 Room 的异步 roster/signal 可能在 leave()
    // 之后晚到，不能再污染随后重新加入的新会话状态。
    room = null
    // 客户端主动离开时先通知房主释放座位（比依赖 SDK 断连检测更可靠、更即时）。
    if (!state.isHost.value) clientLobby?.leave()
    oldRoom?.leave()
    hostLobby = null
    clientLobby = null
    state.roomId.value = ''
    state.mySeat.value = -1
    state.roomSeats.value = []
    state.aiSeats.value = []
    state.isHost.value = false
    state.sessionStatus.value = 'idle'
  }

  async function createRoom(mode: MatchType, capacity: number, rulesetId: RuleVariant, tableThemeName: TableThemeName = 'jade') {
    state.sessionError.value = ''
    state.sessionStatus.value = 'creating'
    try {
      const created = await createVibeRoom({ mode, rulesetId, capacity, tableThemeName })
      room = created
      state.isHost.value = true
      state.roomId.value = created.roomId
      state.mySeat.value = 0
      state.matchType.value = mode
      state.rulesetId.value = rulesetId
      state.tableThemeName.value = tableThemeName
      state.roomSeats.value = [{ seat: 0, peerId: created.peerId, nickname: state.nickname.value, avatar: state.avatar.value, ready: false }]
      state.aiSeats.value = []
      hostLobby = createHostLobby({
        room: created,
        capacity,
        hostNickname: state.nickname.value,
        hostAvatar: state.avatar.value,
        initialTableThemeName: tableThemeName,
        onRoster: (seats, aiSeats) => {
          if (room !== created) return
          state.roomSeats.value = seats
          state.aiSeats.value = aiSeats
        },
        onStart: (details) => {
          if (room !== created) return
          state.aiSeats.value = details.aiSeats
          onStart(created, details)
        },
        // 对局中（phase != lobby）掉线座位锁定给 AI 代打，不能释放给新玩家。
        isInMatch: () => state.phase.value !== 'lobby',
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
      const saved = loadSavedRoom?.()
      const joined = await joinVibeRoom(code)
      room = joined
      state.roomId.value = joined.roomId
      // 元数据非致命：失败不应让客户端停在「房间已设但无座位」的半状态
      // （对局进行中的重进靠快照提供 mode/rulesetId，元数据只是锦上添花）。
      let meta: Awaited<ReturnType<typeof getRoomMeta>> = null
      try { meta = await getRoomMeta(joined.roomId) } catch (error) {
        console.warn('[client] 读房间元数据失败（忽略）:', error)
      }
      // 对局结束/全员离开后房间没有房主：重新加入时 SDK 判定自己为房主（最早成员）。
      // 此时必须走 host 初始化（hostLobby/座位 0），否则按客户端逻辑永远收不到
      // roster → mySeat 恒为 -1 → 连续重试失败（「重进后连座位都没收到」）。
      if (joined.isHost) {
        // P2P 房主掉线后 SDK 可能把某个客户端提升为 host，但该客户端没有房主
        // 引擎的完整隐藏牌墙/请求状态，继续初始化 hostLobby 会制造第二个“权威”
        // 并让房间脑裂。只有明确的空房间、且没有正在恢复的旧会话，才允许新建
        // 大厅；其余情况宁可报告无法安全恢复，也不伪造一局新的权威牌局。
        if (saved?.roomId === joined.roomId || joined.peers().length > 0) {
          joined.leave()
          state.roomId.value = ''
          state.mySeat.value = -1
          state.sessionStatus.value = 'idle'
          throw new Error('原房主已离线，牌局无法安全恢复；未创建新的房主状态')
        }
        state.isHost.value = true
        state.mySeat.value = 0
        const mode = meta?.mode === 'east' || meta?.mode === 'hanchan' ? meta.mode : 'east'
        const ruleset = meta?.rulesetId === 'lotus-classic' || meta?.rulesetId === 'lotus-legacy'
          ? meta.rulesetId
          : 'lotus-classic'
        state.matchType.value = mode
        state.rulesetId.value = ruleset
        const tableThemeName = isTableThemeName(meta?.tableThemeName as string) ? meta?.tableThemeName as TableThemeName : 'jade'
        state.tableThemeName.value = tableThemeName
        const capacity = typeof meta?.max === 'number' ? meta.max : 4
        state.roomSeats.value = [{
          seat: 0, peerId: joined.peerId, nickname: state.nickname.value, avatar: state.avatar.value, ready: false,
        }]
        state.aiSeats.value = []
        hostLobby = createHostLobby({
          room: joined,
          capacity,
          hostNickname: state.nickname.value,
          hostAvatar: state.avatar.value,
          initialTableThemeName: tableThemeName,
          onRoster: (seats, aiSeats) => {
            if (room !== joined) return
            state.roomSeats.value = seats
            state.aiSeats.value = aiSeats
          },
          onStart: (details) => {
            if (room !== joined) return
            state.aiSeats.value = details.aiSeats
            onStart(joined, details)
          },
          isInMatch: () => state.phase.value !== 'lobby',
        })
        // 宣告自己是新房主（携带 mode/ruleset/max），让其他玩家能加入并读对局元数据。
        void joined.announce({
          listed: false,
          open: true,
          max: capacity,
          mode,
          rulesetId: ruleset,
          tableThemeName,
        })
        state.sessionStatus.value = 'connected'
        return
      }
      state.isHost.value = false
      if (meta) {
        if (meta.mode === 'east' || meta.mode === 'hanchan') state.matchType.value = meta.mode
        if (meta.rulesetId === 'lotus-classic' || meta.rulesetId === 'lotus-legacy') state.rulesetId.value = meta.rulesetId
        if (isTableThemeName(meta.tableThemeName as string)) state.tableThemeName.value = meta.tableThemeName as TableThemeName
      }
      clientLobby = createClientLobby({
        room: joined,
        onRoster: (_hostSeat, seats, aiSeats, tableThemeName) => {
          if (room !== joined) return
          state.roomSeats.value = seats
          state.aiSeats.value = aiSeats
          state.tableThemeName.value = tableThemeName
          const own = seats.find((seat) => seat.peerId === joined.peerId)
          // roster 是房主权威事实；如果当前 peer 暂时不在名单中，必须清掉
          // 旧座位，避免重连窗口继续显示“已准备”并把 ready 发给旧连接。
          state.mySeat.value = own?.seat ?? -1
          // 临时诊断：定位「闲家方位是房主方位」的座位分配问题。
          console.log('[client] mySeat:', state.mySeat.value, 'joined.peerId:', joined.peerId, 'seats:', seats.map((s) => `${s.seat}:${s.peerId}`).join(' | '))
        },
        // token 也必须绑定当前 Room。SDK 在 leave() 后仍可能投递旧房间的
        // 定向消息；若旧 token 趁新会话建立前写回 localStorage，下一次重进会
        // 携带错误凭据，表现为“第一次失败、第二次才进房”或座位恢复异常。
        onSeatToken: (token) => {
          if (room === joined) onSeatToken?.(token)
        },
        onStart: (details) => {
          if (room !== joined) return
          state.aiSeats.value = details.aiSeats
          state.tableThemeName.value = details.tableThemeName
          onStart(joined, details)
        },
        onClosed: () => { if (room === joined) onClosed() },
      })
      const savedToken = saved?.roomId === joined.roomId ? saved.seatToken : undefined
      clientLobby.hello(state.nickname.value, state.avatar.value, state.playerId.value, savedToken)
      state.sessionStatus.value = 'connected'
    } catch (error) {
      state.sessionError.value = readableError(error, '加入房间失败')
      state.sessionStatus.value = 'idle'
      console.error('[client] 加入/重进房间失败:', error)
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
    if (!state.isHost.value) return
    const started = hostLobby?.requestStart() ?? false
    if (!started) throw new Error('大厅成员状态已变化，请确认所有玩家仍已准备')
  }

  function setAiSeats(aiSeats: PublicAiSeat[]): void {
    if (!state.isHost.value) return
    hostLobby?.setAiSeats(aiSeats)
  }

  function setTableTheme(tableThemeName: TableThemeName): void {
    if (!state.isHost.value) return
    state.tableThemeName.value = tableThemeName
    hostLobby?.setTableTheme(tableThemeName)
    void room?.announce({
      listed: false,
      open: true,
      max: 4,
      mode: state.matchType.value,
      rulesetId: state.rulesetId.value,
      tableThemeName,
    })
  }

  async function leaveRoom(): Promise<void> {
    // 房主离开也广播 lobby_closed：让客户端立即感知「房主已离开/关闭房间」，
    // 而不是只看到 SDK 层的「网络断开，正在重连」干等超时。客户端主动离开
    // （isHost=false）不需要广播。
    if (state.isHost.value) {
      hostLobby?.close()
      // 给 lobby_closed 广播留出送达时间：send 后立即 leave 会切断通道，消息可能丢失。
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    clearSession()
  }

  async function closeRoom(): Promise<void> {
    if (state.isHost.value) hostLobby?.close()
    // 给 lobby_closed 广播留出送达时间：send 后立即 leave 会切断通道，消息可能丢失，
    // 客户端收不到「房间已关闭」只能看到「网络断开，正在重连」。
    await new Promise((resolve) => setTimeout(resolve, 400))
    clearSession()
  }

  async function resumeSession(): Promise<void> {
    // 刷新页面重进：用上次保存的房间码重新加入（对局进行中则经快照重同步 + rejoin_ok 恢复座位）。
    const saved = loadSavedRoom?.()
    if (saved?.roomId) {
      if (saved.nickname) state.nickname.value = saved.nickname
      await joinRoom(saved.roomId)
    }
  }

  return {
    createRoom,
    joinRoom,
    toggleReady,
    startMatch,
    setAiSeats,
    setTableTheme,
    leaveRoom,
    closeRoom,
    resumeSession,
    getRoom: () => room,
  }
}
