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
  startRoom, updateCharacter, type LlmSeatRequest, type RoomSeatState,
} from '../../../online/api/roomApi'
import { createRoomSocketTransport } from '../../../online/transport/roomSocket'
import { createRemoteSessionStore, generateGuestId, type StoredSession } from '../../../online/session/remoteSessionStore'

const remoteSessionStore = createRemoteSessionStore()
import type { BloodFlowGameOptions } from './useBloodFlowGame'
import { useBloodFlowGame } from './useBloodFlowGame'
import { createBloodFlowWsAuthority } from './ws/authority'

const WS_BASE = API_BASE.replace(/^http/, 'ws')

export type BloodFlowRemoteSessionStatus = 'idle' | 'lobby' | 'error'

export interface BloodFlowRemoteGameOptions {
  playSound: BloodFlowGameOptions['playSound']
  playSoundAndWait: BloodFlowGameOptions['playSoundAndWait']
  getThemeName: () => string
  animeFixedTts: BloodFlowGameOptions['animeFixedTts']
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
  const roomTimeLimit = ref(600)
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
    getThemeName: options.getThemeName,
    animeFixedTts: options.animeFixedTts,
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
      if (code === 'AUTH_REQUIRED') window.dispatchEvent(new Event('wakudemo-auth-required'))
      else sessionError.value = code
    },
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
    roomTimeLimit.value = info.timeLimitSeconds ?? 600
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

  async function createRoom(mode: MatchType, capacity: number, _rulesetId?: RuleVariant, llm?: boolean) {
    const info = await createRoomApi(mode, capacity, playerId.value, 'lotus-blood-flow', llm)
    roomId.value = info.roomId
    isCreator.value = true
    await joinRoom(roomId.value)
    await refreshRoom()
    sessionStatus.value = 'lobby'
    startLobbyPolling()
  }

  async function joinRoom(code: string) {
    const result = await joinRoomApi(code, nickname.value || '玩家', playerId.value)
    roomId.value = result.roomId
    mySeat.value = result.seat
    rejoinCode.value = result.rejoinCode
    nickname.value = result.nickname
    saveSession()
    await refreshRoom()
    sessionStatus.value = 'lobby'
    socket.open()  // 入房即连：非房主也能收到开局后的权威快照
    startLobbyPolling()
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

  async function leaveRoom() {
    stopLobbyPolling()
    socket.close()
    if (roomId.value && mySeat.value >= 0) {
      try { await leaveRoomApi(roomId.value, mySeat.value, rejoinCode.value) } catch { /* 已解散等 */ }
    }
    remoteSessionStore.clearSession()
    storedSession.value = null
    roomId.value = ''
    rejoinCode.value = ''
    mySeat.value = -1
    isCreator.value = false
    roomSeats.value = []
    sessionStatus.value = 'idle'
    waitingNextRound.value = false
    seenRound = -1
    inner.dispose()
  }

  async function closeRoom() {
    if (roomId.value && mySeat.value >= 0) {
      try { await closeRoomApi(roomId.value, mySeat.value, rejoinCode.value) } catch { /* 已解散等 */ }
    }
    await leaveRoom()
  }

  function toggleAutoPlay() {
    autoPlay.value = !autoPlay.value
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
    updateCharacter: updateCharacterRemote,
  }

  return {
    ...inner,
    // 远程开局/续局走 REST 房间生命周期；本地引擎不自行开桌。
    startGame: () => { /* 远程开局由 remoteActions.startMatch（REST）驱动 */ },
    nextRound: () => confirmNextRound(),
    returnToLobby: () => { void leaveRoom() },
    rulesetId,
    sessionStatus,
    sessionError,
    roomId,
    mySeat,
    nickname,
    playerId,
    isCreator,
    roomSeats,
    roomTimeLimit,
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
