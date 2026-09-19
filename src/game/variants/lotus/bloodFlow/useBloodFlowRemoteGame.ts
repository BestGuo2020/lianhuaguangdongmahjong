// 血流联机（WS 权威）对局与房间会话 —— App.vue 的远程血流槽位。
//
// 复用 useBloodFlowGame（externalAuthority 端口）+ 后端血流房间协议（bf_snapshot）。
// 大厅生命周期对齐 useRemoteGame 的表层形状（sessionStatus/roomId/mySeat/…），
// 但快照与动作走血流自己的 authority，不复用经典 state_snapshot 协议。
// v1 边界：无观战；断线重连经 rejoin_ok 恢复座位（重连不重播开局动画）。
import { computed, ref } from 'vue'
import type { MatchType } from '../../../core/contracts/types'
import type { TableThemeName } from '../../../../theme/themeIdentity'
import type { RuleVariant } from '../../../core/rules/ruleVariants'
import { API_BASE } from '../../../online/api/httpClient'
import {
  closeRoom as closeRoomApi, createRoom as createRoomApi, getRoom,
  joinRoom as joinRoomApi, leaveRoom as leaveRoomApi, readyRoom,
  reserveLlmSeat as reserveLlmSeatApi,
  startRoom, updateCharacter, type LlmSeatRequest, type RoomSeatState,
  type ServerLlmStyle,
} from '../../../online/api/roomApi'
import { createRoomSocketTransport } from '../../../online/transport/roomSocket'
import { createRemoteSessionStore, generateGuestId, type StoredSession } from '../../../online/session/remoteSessionStore'

const remoteSessionStore = createRemoteSessionStore()
import type { BloodFlowGameOptions } from './useBloodFlowGame'
import { useBloodFlowGame } from './useBloodFlowGame'
import { createBloodFlowWsAuthority } from './ws/authority'

const WS_BASE = API_BASE.replace(/^http/, 'ws')

export type BloodFlowRemoteSessionStatus = 'idle' | 'creating' | 'joining' | 'lobby' | 'error'

/** 会话级错误码 → 大厅可读文案（与经典 remoteRoomLifecycle 同口径）。 */
const SESSION_ERROR_TEXT: Record<string, string> = {
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

function readableSessionError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return SESSION_ERROR_TEXT[error.message] ?? error.message
}

/** 服务端对「过期/重复动作」的拒绝码：属预期竞态，不向用户报错（仅控制台留痕）。 */
const ACTION_RACE_ERRORS = new Set(['STALE_ACTION', 'INVALID_ACTION'])

export interface BloodFlowRemoteGameOptions {
  playSound: BloodFlowGameOptions['playSound']
  playSoundAndWait: BloodFlowGameOptions['playSoundAndWait']
  /** 本家二次元角色：入房时随 join 上报（此前漏传，服务端永远退回 deepseek）。 */
  getCharacterId?: () => string
  /** 服务端 TTS 音频通道（联机模型原话，与经典联机同一条队列）。 */
  playLlmAudio?: BloodFlowGameOptions['playLlmAudio']
  getThemeName: () => string
  animeFixedTts: BloodFlowGameOptions['animeFixedTts']
  /** 全场胡牌张数到阈值换 BGM（联机各端本地播放，与权威状态同源）。 */
  bgm?: BloodFlowGameOptions['bgm']
}

export function useBloodFlowRemoteGame(options: BloodFlowRemoteGameOptions) {
  const sessionStatus = ref<BloodFlowRemoteSessionStatus>('idle')
  const sessionError = ref('')
  const roomId = ref('')
  const mySeat = ref(-1)
  const nickname = ref('')
  const playerId = ref(remoteSessionStore.loadGuestId() || generateGuestId())
  remoteSessionStore.saveGuestId(playerId.value)
  const rejoinCode = ref('')
  const isCreator = ref(false)
  const roomSeats = ref<Array<RoomSeatState | null>>([])
  /** 房主预留的空位（大模型专属，真人不可加入）；其余空位「自动选择」= 真人可占。 */
  const reservedSeats = ref<Array<LlmSeatRequest>>([])
  // 房间限时与经典房间同口径（服务端 ROOM_LIFETIME，默认 60 分钟）；仅大厅提示用。
  const roomTimeLimit = ref(3600)
  /** 服务端房间状态：暂离（房间进行中）时房间面板据此显示「回到牌桌」。 */
  const roomStatus = ref<'lobby' | 'playing' | 'finished' | 'error' | 'closed'>('lobby')
  const storedSession = ref<StoredSession | null>(null)
  const rulesetId = ref<RuleVariant>('lotus-blood-flow')
  const roomTableThemeName = ref<TableThemeName>('jade')
  const llmEnabled = ref(false)
  const effectiveLlmEnabled = ref(false)
  const llmAvailable = ref(false)
  const autoPlay = ref(false)
  const waitingNextRound = ref(false)
  const signalQuality = ref(0)
  let seenRound = -1

  // ── 底层对局端口：externalAuthority 桥接到 WS。 ──
  const inner = useBloodFlowGame({
    playSound: options.playSound,
    playSoundAndWait: options.playSoundAndWait,
    playLlmAudio: options.playLlmAudio,
    getThemeName: options.getThemeName,
    animeFixedTts: options.animeFixedTts,
    bgm: options.bgm,
    externalAuthority: {
      send: (command) => authority.send(command),
      nextRound: () => confirmNextRound(),
      leave: () => { /* 离开由房间生命周期管理 */ },
      openingDone: (round) => authority.openingDone(round),
    },
  })

  const socket = createRoomSocketTransport({
    getUrl: () => roomId.value && rejoinCode.value
      ? `${WS_BASE}/ws/room/${encodeURIComponent(roomId.value)}?rejoin_code=${encodeURIComponent(rejoinCode.value)}`
      : null,
    onMessage: (message) => {
      const kind = (message as { kind?: unknown })?.kind
      if (kind === 'rejoin_ok') {
        const payload = message as { seat?: number; nickname?: string }
        if (typeof payload.seat === 'number') mySeat.value = payload.seat
        if (typeof payload.nickname === 'string') nickname.value = payload.nickname
        socket.confirmSession()
        sessionStatus.value = 'lobby'
        // 重连成功即视为会话健康：清掉上一次的错误提示。
        sessionError.value = ''
        // 重连/刷新后把托管状态同步给服务端（服务端按座位记忆，刷新后本地 ref 会归零）。
        authority.setAuto(autoPlay.value)
      }
      // 房间已解散（房主离开/关闭、超时回收）或座位失效：清理本地会话回主大厅，
      // 不再对着死房间无限重连（对齐经典 room_closed 处理）。
      if (kind === 'room_closed'
        || (kind === 'rejoin_err' && ['ROOM_NOT_FOUND', 'REJOIN_CODE_INVALID'].includes(
          String((message as { code?: unknown }).code ?? '')))) {
        resetSessionLocal()
        return
      }
      authority.feed(message)
    },
  })
  const authority = createBloodFlowWsAuthority({
    transport: socket,
    onView: (view, meta) => {
      // 新一局开始（局号前进）或整场结束 → 解除「等待其他玩家」态。
      if (meta.round > seenRound || meta.matchFinished) waitingNextRound.value = false
      seenRound = meta.round
      void inner.acceptRemoteView(view, meta)
    },
    onError: (code) => {
      if (code === 'AUTH_REQUIRED') {
        window.dispatchEvent(new Event('wakudemo-auth-required'))
        return
      }
      // 动作竞态是预期内的：窗口已被裁决/推进/超时后，客户端旧按钮上的重复或迟到提交
      // 必被服务端拒绝。它不是会话故障，不能写进 sessionError（那份错误只在大厅显示，
      // 会一直挂到「返回大厅」时冒出来——用户看到的正是这个）。
      if (ACTION_RACE_ERRORS.has(code)) {
        console.warn(`[blood-flow] 动作被服务端拒绝（预期竞态）：${code}`)
        return
      }
      sessionError.value = code
    },
    // 服务端模型原话与 TTS：气泡落牌桌、音频走公共 llm 音频队列（不再用客户端模板台词）。
    onSpeech: (message) => inner.presentRemoteModelSpeech(message),
    onAudio: (message) => inner.playRemoteModelAudio(`${API_BASE}${message.audioUrl}`, message),
  })

  // ── 房间会话（REST，对齐 remoteRoomLifecycle 的表层） ──

  function saveSession() {
    storedSession.value = {
      roomId: roomId.value, rejoinCode: rejoinCode.value, nickname: nickname.value,
      playerId: playerId.value, mode: 'east', rulesetId: 'lotus-blood-flow',
    }
    remoteSessionStore.saveSession(storedSession.value)
  }

  async function refreshRoom() {
    if (!roomId.value) return
    const info = await getRoom(roomId.value)
    roomSeats.value = info.seats
    reservedSeats.value = info.reservedSeats ?? []
    roomStatus.value = info.status
    roomTimeLimit.value = info.timeLimitSeconds ?? 3600
    isCreator.value = info.creatorSeat === mySeat.value
    llmEnabled.value = Boolean(info.llmEnabled)
    effectiveLlmEnabled.value = Boolean(info.effectiveLlmEnabled)
    llmAvailable.value = Boolean(info.llmAvailable)
    if (info.status === 'finished') sessionStatus.value = 'lobby'
  }

  // 大厅座位状态轮询（对齐经典房间 1.5s）：ready/加入变化无服务端推送。
  let pollTimer: number | null = null
  function startLobbyPolling() {
    stopLobbyPolling()
    pollTimer = globalThis.setInterval(() => {
      if (roomId.value && inner.phase.value === 'lobby') void refreshRoom()
    }, 1500) as unknown as number
  }
  function stopLobbyPolling() {
    if (pollTimer != null) globalThis.clearInterval(pollTimer)
    pollTimer = null
  }

  /** 占座结果落地（createRoom / joinRoom 共用）：座位身份 + 会话持久化。 */
  function applyJoinResult(result: { roomId: string; seat: number; rejoinCode: string; nickname: string }) {
    roomId.value = result.roomId
    mySeat.value = result.seat
    rejoinCode.value = result.rejoinCode
    nickname.value = result.nickname
    saveSession()
  }

  async function createRoom(mode: MatchType, capacity: number, _rulesetId?: RuleVariant, llm?: boolean) {
    // 防重复创建：大厅按钮已按 sessionStatus='creating' 禁用，这里再兜一层（连点/回车重复触发）。
    if (sessionStatus.value === 'creating' || roomId.value) return
    sessionStatus.value = 'creating'
    sessionError.value = ''
    try {
      const info = await createRoomApi(mode, capacity, playerId.value, 'lotus-blood-flow', llm)
      isCreator.value = true
      applyJoinResult(await joinRoomApi(info.roomId, nickname.value || '玩家', playerId.value,
        options.getCharacterId?.()))
      await refreshRoom()
      sessionStatus.value = 'lobby'
      socket.open()  // 入房即连：非房主也能收到开局后的权威快照
      startLobbyPolling()
    } catch (error) {
      // 失败必须回 idle 并给出可读原因：否则按钮永远停在「创建中…」，且失败被静默吞掉。
      sessionStatus.value = 'idle'
      sessionError.value = readableSessionError(error, '创建房间失败')
      throw error
    }
  }

  async function joinRoom(code: string) {
    if (sessionStatus.value === 'joining' || roomId.value) return
    sessionStatus.value = 'joining'
    sessionError.value = ''
    try {
      applyJoinResult(await joinRoomApi(code, nickname.value || '玩家', playerId.value,
        options.getCharacterId?.()))
      await refreshRoom()
      sessionStatus.value = 'lobby'
      socket.open()
      startLobbyPolling()
    } catch (error) {
      sessionStatus.value = 'idle'
      sessionError.value = readableSessionError(error, '加入房间失败')
      throw error
    }
  }

  async function toggleReady() {
    if (mySeat.value < 0 || !roomId.value) return
    const result = await readyRoom(roomId.value, mySeat.value, rejoinCode.value)
    const index = roomSeats.value.findIndex((seat) => seat?.seat === result.seat)
    if (index >= 0 && roomSeats.value[index]) {
      roomSeats.value = [...roomSeats.value]
      roomSeats.value[index] = { ...roomSeats.value[index]!, ready: result.ready }
    }
  }

  async function startMatch(llmSeats: Array<LlmSeatRequest> = []) {
    if (!roomId.value) return
    await startRoom(roomId.value, llmSeats)
    sessionStatus.value = 'lobby'
    socket.open()
  }

  /**
   * 房主为某个空位写 / 清大模型预留：`providerId` 为空 = 取消预留（改回「自动选择」）。
   * 与经典房间同契约：预留写在服务端房间上，别人 join 时据此跳过该座。
   */
  async function reserveLlmSeat(reserveSeat: number, providerId: string | null,
    style: ServerLlmStyle | null) {
    if (!roomId.value || mySeat.value < 0 || !rejoinCode.value) return
    sessionError.value = ''
    try {
      const result = await reserveLlmSeatApi(roomId.value, mySeat.value, rejoinCode.value,
        reserveSeat, providerId, style)
      reservedSeats.value = result.reservedSeats ?? []
    } catch (error) {
      sessionError.value = readableSessionError(error, '设置大模型预留失败')
      await refreshRoom().catch(() => {})
    }
  }

  async function resumeSession() {
    const session = remoteSessionStore.loadSession()
    if (!session || session.rulesetId !== 'lotus-blood-flow') return
    storedSession.value = session
    roomId.value = session.roomId
    rejoinCode.value = session.rejoinCode
    nickname.value = session.nickname
    playerId.value = session.playerId
    await refreshRoom()
    sessionStatus.value = 'lobby'
    startLobbyPolling()
    socket.open()
  }

  /** 本地会话清理（不走 REST）：room_closed / 重进失效 / 主动离开共用。 */
  function resetSessionLocal() {
    stopLobbyPolling()
    socket.close()
    // 先复位对局端口（phase→lobby、清空玩家与结算态）：inner.dispose() 只清定时器/worker，
    // 不复位 phase/players，会让大厅因 App 的 showLobby 条件（phase==='lobby' || players.length===0）
    // 无法出现。
    inner.returnToLobby()
    remoteSessionStore.clearSession()
    storedSession.value = null
    roomId.value = ''
    rejoinCode.value = ''
    mySeat.value = -1
    isCreator.value = false
    roomSeats.value = []
    reservedSeats.value = []
    sessionStatus.value = 'idle'
    sessionError.value = ''
    roomStatus.value = 'lobby'
    waitingNextRound.value = false
    seenRound = -1
  }

  async function leaveRoom() {
    const leavingRoom = roomId.value
    const leavingSeat = mySeat.value
    const leavingCode = rejoinCode.value
    resetSessionLocal()
    if (leavingRoom && leavingSeat >= 0) {
      try { await leaveRoomApi(leavingRoom, leavingSeat, leavingCode) } catch { /* 已解散等 */ }
    }
  }

  /**
   * 暂离（牌桌「返回大厅」）：**不退出房间**——保留座位、重进码与会话，只主动断开 WS
   * （服务端按断线 AI 托管、且不再计入待决策与局间屏障），本机停在房间面板；
   * 面板显示「本场进行中 · 你在暂离」并可「回到牌桌」（重连恢复原座位）。
   */
  async function stepOutToLobby() {
    stopLobbyPolling()
    socket.close()          // 意图关闭：不自动重连；服务端 on_disconnect → AI 托管
    inner.returnToLobby()   // 复位牌桌视图 → phase 回 lobby（房间面板可见）
    sessionStatus.value = 'lobby'
    waitingNextRound.value = false
    seenRound = -1
    sessionError.value = ''
    // 刷新座位表（本家显示未连接）；房间若已被回收（404）→ 会话整体清理回主大厅。
    try { await refreshRoom() } catch { resetSessionLocal(); return }
    startLobbyPolling()
  }

  /**
   * 退出本场：回主大厅，**保留座位与会话**（不 REST leave）——座位交服务端 AI 打完本场，
   * 大厅显示「继续对局（房间 X）」，可随时重进原座位（走 WS 重进握手，不需要 REST join）。
   */
  function leaveMatch() {
    stopLobbyPolling()
    socket.close()
    inner.returnToLobby()
    sessionStatus.value = 'idle'
    waitingNextRound.value = false
    seenRound = -1
    sessionError.value = ''
    roomId.value = ''
    mySeat.value = -1
    isCreator.value = false
    roomSeats.value = []
    reservedSeats.value = []
    roomStatus.value = 'lobby'
    // storedSession（含 rejoinCode）保留：大厅据它显示「继续对局」，重进即恢复原座位。
  }

  /** 结算页「返回大厅」：
   *  - 整场结束 → 对齐经典 remoteMatchLifecycle.returnToLobby：**不离开房间**，复位牌桌视图
   *    回房间大厅（房间保留；准备态保留，房主可直接再开一场）。
   *  - 对局中途 → **暂离**（不退出房间）：座位与重进码保留，本场交服务端 AI 代打，
   *    可随时「回到牌桌」。此前这里等于 leaveRoom，等于中途退出且本场结束前无法回来。 */
  function returnToLobby() {
    if (inner.matchFinished.value) {
      inner.returnToLobby()
      waitingNextRound.value = false
      seenRound = -1
      sessionStatus.value = 'lobby'
      // 回房间大厅即视为一段流程结束：清掉上一场残留的错误提示。
      sessionError.value = ''
      // 刷新房间面板数据；房间若已被回收（404）则整体清理回主大厅。
      void refreshRoom().catch(() => resetSessionLocal())
      return
    }
    void stepOutToLobby()
  }

  async function closeRoom() {
    if (roomId.value && mySeat.value >= 0) {
      try { await closeRoomApi(roomId.value, mySeat.value, rejoinCode.value) } catch { /* 已解散等 */ }
    }
    await leaveRoom()
  }

  function toggleAutoPlay() {
    autoPlay.value = !autoPlay.value
    // 血流托管由服务端代打（对齐 P2P 的 blood_flow_auto）：本地翻转只是 UI 状态。
    authority.setAuto(autoPlay.value)
  }

  function configureTableTheme(theme: TableThemeName) {
    roomTableThemeName.value = theme
  }

  function updatePresentationAudioMode() { /* 血流 v1 无按座位观众音频模式 */ }

  /** 结算页确认「下一局」：回执局间屏障（后端等所有在线真人确认后开新局）。 */
  function confirmNextRound() {
    if (inner.matchFinished.value) return
    authority.continueRound()
    waitingNextRound.value = true
  }

  async function updateCharacterRemote(characterId: string) {
    if (mySeat.value >= 0 && roomId.value) {
      await updateCharacter(roomId.value, mySeat.value, rejoinCode.value, characterId)
    }
  }

  const remoteActions = {
    createRoom, joinRoom, toggleReady, startMatch, leaveRoom, closeRoom, resumeSession,
    stepOutToLobby, leaveMatch, reserveLlmSeat,
    updateCharacter: updateCharacterRemote,
  }

  return {
    ...inner,
    // 远程开局/续局走 REST 房间生命周期；本地引擎不自行开桌。
    startGame: () => { /* 远程开局由 remoteActions.startMatch（REST）驱动 */ },
    nextRound: () => confirmNextRound(),
    returnToLobby: () => returnToLobby(),
    rulesetId,
    sessionStatus,
    sessionError,
    roomId,
    mySeat,
    nickname,
    playerId,
    isCreator,
    roomSeats,
    reservedSeats,
    roomTimeLimit,
    roomStatus,
    storedSession,
    wsStatus: socket.status,
    signalQuality: computed(() => socket.signalQuality.value),
    remoteActions,
    waitingNextRound,
    llmEnabled,
    effectiveLlmEnabled,
    llmAvailable,
    autoPlay,
    toggleAutoPlay,
    roomTableThemeName,
    configureTableTheme,
    updatePresentationAudioMode,
  }
}
