import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useRemoteGame } from './useRemoteGame'
import { useBloodFlowRemoteGame } from './useBloodFlowRemoteGame'
import { useWakuDemoAuth } from '../../../account/wakudemo/useWakuDemoAuth'
import { createRemoteLobbyController } from './orchestration/remoteLobbyController'
import { useDisclaimerGate } from './session/useDisclaimerGate'
import { useRoomAvailability } from './session/useRoomAvailability'
import { getRoom, type LlmSeatRequest, type ServerLlmStyle } from './api/roomApi'
import type { StoredSession } from './session/remoteSessionStore'
import type { MatchType } from '../../core/contracts/types'
import type { GamePort } from '../../core/contracts/gamePort'
import type { GameMode } from '../../core/contracts/activeGamePort'
import type { RuleVariant } from '../../core/rules/ruleVariants'
import type { TableThemeName } from '../../../components/table/three/tableTheme'

type Options = Parameters<typeof useRemoteGame>[0] & {
  gameMode: Ref<GameMode>
  selectedRule: Ref<RuleVariant>
  selectedMatch: Ref<MatchType>
  startBgm(): void
}

/** 独立站适配层：保持原 HTTP/WS 会话语义，向共享 App 暴露统一牌桌端口。 */
export function useWsOnline(options: Options) {
  const { gameMode, selectedRule, selectedMatch, startBgm } = options
  const remoteGame = useRemoteGame(options)
  const bloodFlowRemoteGame = useBloodFlowRemoteGame({
    playSound: options.playSound,
    playSoundAndWait: options.playSoundAndWait,
    playLlmAudio: options.playLlmAudio,
    getCharacterId: options.getCharacterId,
    getThemeName: options.getThemeName,
    animeFixedTts: options.animeFixedTts,
  })
  const activeRemote = computed(() => (
    gameMode.value === 'remote' && selectedRule.value === 'lotus-blood-flow'
      ? bloodFlowRemoteGame : remoteGame
  ))
  const phase = computed(() => activeRemote.value.phase.value)
  // ── 联机模式状态（远程房间 / WS 连接）──
  // 血流联机房间走自己的会话：以下代理在联机槽切换时读取/写入对应模块的真实 ref。
  const proxyRef = <T,>(name: 'sessionStatus' | 'sessionError' | 'roomId' | 'mySeat' | 'nickname'
    | 'playerId' | 'isCreator' | 'roomSeats' | 'reservedSeats' | 'roomTimeLimit' | 'roomStatus'
    | 'storedSession'
    | 'llmEnabled' | 'effectiveLlmEnabled' | 'llmAvailable' | 'autoPlay'
    | 'roomTableThemeName') => computed<T>({
    get: () => activeRemote.value[name].value as T,
    set: (value: T) => { (activeRemote.value[name] as { value: T }).value = value },
  })
  const sessionStatus = proxyRef<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'lobby' | 'error' | string>('sessionStatus')
  const sessionError = proxyRef<string>('sessionError')
  const roomId = proxyRef<string>('roomId')
  const mySeat = proxyRef<number>('mySeat')
  const nickname = proxyRef<string>('nickname')
  const playerId = proxyRef<string>('playerId')
  const isCreator = proxyRef<boolean>('isCreator')
  const roomSeats = proxyRef<Array<{ seat: number; nickname: string; ready: boolean; connected: boolean; characterId?: string } | null>>('roomSeats')
  /** 房主预留的空位（大模型专属，真人不可加入）；未列入的空位「自动选择」= 真人可占。 */
  const reservedSeats = proxyRef<Array<LlmSeatRequest>>('reservedSeats')
  const roomTimeLimit = proxyRef<number>('roomTimeLimit')
  /** 服务端房间状态：blood flow 暂离时房间面板据此显示「本场进行中 · 回到牌桌」。 */
  const roomStatus = proxyRef<'lobby' | 'playing' | 'finished' | 'error' | 'closed' | string>('roomStatus')
  const storedSession = proxyRef<StoredSession | null>('storedSession')
  const llmEnabled = proxyRef<boolean>('llmEnabled')
  const effectiveLlmEnabled = proxyRef<boolean>('effectiveLlmEnabled')
  const llmAvailable = proxyRef<boolean>('llmAvailable')
  const remoteAutoPlay = proxyRef<boolean>('autoPlay')
  const roomTableThemeName = proxyRef<TableThemeName>('roomTableThemeName')
  const wsStatus = computed(() => activeRemote.value.wsStatus.value)
  const signalQuality = computed(() => activeRemote.value.signalQuality.value)
  const waitingNextRound = computed(() => activeRemote.value.waitingNextRound.value)
  const toggleAutoPlay = () => activeRemote.value.toggleAutoPlay()
  const configureTableTheme = (theme: TableThemeName) => activeRemote.value.configureTableTheme(theme)
  // 动作委托：调用瞬间路由到当前联机槽（经典或血流）。
  const remoteActions = {
    createRoom: (mode: MatchType, capacity: number, rulesetId?: RuleVariant, llmEnabled?: boolean) =>
      activeRemote.value.remoteActions.createRoom(mode, capacity, rulesetId, llmEnabled),
    joinRoom: async (code: string) => {
      // 联机槽按目标房间玩法路由：血流房间必须走血流模块（先查房间元数据再入房）。
      const info = await getRoom(code).catch(() => null)
      if (info?.rulesetId === 'lotus-classic' || info?.rulesetId === 'lotus-legacy' || info?.rulesetId === 'lotus-blood-flow') {
        // 必须在切槽前取昵称：切槽后读的是血流模块自己的（尚未填写的）空值。
        const carriedNickname = nickname.value
        const carriedPlayerId = playerId.value
        selectedRule.value = info.rulesetId
        if (carriedNickname) activeRemote.value.nickname.value = carriedNickname
        if (carriedPlayerId) activeRemote.value.playerId.value = carriedPlayerId
      }
      await activeRemote.value.remoteActions.joinRoom(code)
    },
    toggleReady: () => activeRemote.value.remoteActions.toggleReady(),
    startMatch: (llmSeats?: Parameters<typeof activeRemote.value.remoteActions.startMatch>[0]) =>
      activeRemote.value.remoteActions.startMatch(llmSeats as never),
    // 房主为空位选模型 = 该座预留给大模型（真人不可加入）；改回「自动选择」= 取消预留。
    reserveLlmSeat: (payload: { seat: number; providerId: string | null; style: ServerLlmStyle | null }) =>
      activeRemote.value.remoteActions.reserveLlmSeat(payload.seat, payload.providerId, payload.style),
    leaveRoom: () => activeRemote.value.remoteActions.leaveRoom(),
    closeRoom: () => activeRemote.value.remoteActions.closeRoom(),
    // 暂离（返回大厅）：保留座位与会话，只断开牌桌连接；退出本场：回主大厅但座位仍保留可重进。
    stepOutToLobby: () => activeRemote.value.remoteActions.stepOutToLobby(),
    leaveMatch: () => activeRemote.value.remoteActions.leaveMatch(),
    resumeSession: () => {
      // 刷新后当前单机规则可能与保存的联机房间不同；先切到对应联机协议再重进。
      const session = storedSession.value
      if (session?.rulesetId) selectedRule.value = session.rulesetId
      return activeRemote.value.remoteActions.resumeSession()
    },
    updateCharacter: (characterId: string) => activeRemote.value.remoteActions.updateCharacter(characterId),
  }

  const { roomMeta } = useRoomAvailability(gameMode, roomId)

  const disclaimerGate = useDisclaimerGate()
  const wakuAuth = useWakuDemoAuth()

  // 联机对战需登录：未登录时不跳转、不弹窗，只在大厅登录卡片处显示内联提示；
  // 玩家自行点卡片上的「登录」按钮后，登录成功自动进入联机模式。
  const pendingRemoteLogin = ref(false)

  function onGameModeChange(mode: GameMode) {
    if (mode === 'remote' && !wakuAuth.authenticated.value) {
      pendingRemoteLogin.value = true
      wakuAuth.error.value = '联机对战需要先登录 WakuDemo 账号'
      return
    }
    gameMode.value = mode
  }

  // 登录成功后自动进入联机模式（此前玩家已点过联机对战）。
  watch(() => wakuAuth.authenticated.value, (authenticated) => {
    if (authenticated && pendingRemoteLogin.value) {
      pendingRemoteLogin.value = false
      gameMode.value = 'remote'
    }
  })

  // 联机接口返回 401 AUTH_REQUIRED 时提示重新登录（不跳转、不弹窗）。
  function handleAuthRequired() {
    if (!wakuAuth.authenticated.value) {
      wakuAuth.error.value = '登录已过期，请重新登录 WakuDemo 账号'
    }
  }
  onMounted(() => window.addEventListener('wakudemo-auth-required', handleAuthRequired))
  onBeforeUnmount(() => window.removeEventListener('wakudemo-auth-required', handleAuthRequired))

  const lobbyController = createRemoteLobbyController({
    gameMode,
    selectedMatch,
    selectedRule,
    phase,
    roomId,
    nickname,
    playerId,
    roomSeats,
    actions: remoteActions,
    guardEntry: disclaimerGate.guard,
    startBgm,
  })
  // 联机昵称以登录账号为准：账号给出昵称时始终覆盖昵称框（刷新、切换账号都重算，
  // 本地旧昵称与玩家手输内容不再优先）；账号没有昵称时保留昵称框原值，玩家仍可自己填。
  watch(() => wakuAuth.account.value?.displayName, (displayName) => {
    lobbyController.applyAccountNickname(displayName)
  }, { immediate: true })


  watch(gameMode, mode => { if (mode !== 'remote') pendingRemoteLogin.value = false })
  return {
    port: () => activeRemote.value as GamePort,
    rulesetId: computed(() => activeRemote.value.rulesetId.value),
    secondDice: computed(() => activeRemote.value.secondDice?.value ?? undefined),
    sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, playerId,
    isHost: isCreator, roomSeats, roomTimeLimit, roomStatus, storedSession,
    reservedSeats, llmEnabled, effectiveLlmEnabled, llmAvailable, roomMeta,
    waitingNextRound, signalQuality, roomTableThemeName,
    autoPlay: remoteAutoPlay, toggleAutoPlay,
    rejoining: ref(false),
    remoteActions: {
      ...remoteActions,
      configureTableTheme(theme: TableThemeName) {
        configureTableTheme(theme)
        activeRemote.value.updatePresentationAudioMode()
      },
    },
    lobbyController, disclaimerGate, wakuAuth, onGameModeChange,
  }
}
