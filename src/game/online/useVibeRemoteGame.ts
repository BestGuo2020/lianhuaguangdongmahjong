// VibeHub P2P 远程对局 composable（Phase 1/2 组装）：与 useRemoteGame 返回兼容的 GamePort，
// 但房间生命周期走 vibeRoomSession（SDK rooms + vibeLobby），实时对局走 vibeRoomTransport
// （SDK Room P2P 消息）。客户端角色复用 useRemoteGame 的快照驱动逻辑；房主角色另由
// hostGameRunner 组装（后续接入）。
//
// 与 useRemoteGame 的关键差异：
// - 无 rejoin_ok/rejoin_err 握手：mySeat 由大厅 roster 分配（vibeRoomSession）。
// - 座位表用 LobbySeat（含 peerId），isHost 取代 isCreator/creatorSeat。
// - 传输层在 join 后由 vibeRoomTransport 绑定一次（getRoom 返回已加入的 Room）。
import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { defineGamePort, type GamePort } from '../core/contracts/gamePort'
import type { RoundResult } from '../core/contracts/gamePort'
import { tileName } from '../core/rules/tiles'
import type { MatchType, TileType, WinPresentation } from '../core/contracts/types'
import { LOTUS_RULESET } from '../variants/lotus/lotusRules'
import { createPlayerSelectors } from '../core/selectors/playerSelectors'
import type { ServerPlayerDto, ServerSnapshot } from './protocol/dto'
import type { ServerMessage } from './protocol/messages'
import { createRemoteSessionStore } from './session/remoteSessionStore'
import { createVibeRoomSession } from './vibe/vibeRoomSession'
import { createVibeRoomTransport } from './transport/vibeRoomTransport'
import { createOpeningTimeline } from './presentation/openingTimeline'
import { createSettlementTimeline } from './presentation/settlementTimeline'
import { createRemoteGameState } from './state/remoteGameState'
import { createSnapshotReconciler } from './orchestration/snapshotReconciler'
import { createServerMessageRouter } from './orchestration/serverMessageRouter'
import { createRequestCoordinator } from './orchestration/requestCoordinator'
import { createRemoteActionController, type RemotePlayerActionMessage } from './orchestration/remoteActionController'
import { createTransientEventPresenter } from './presentation/transientEventPresenter'
import { createRemoteMatchLifecycle } from './orchestration/remoteMatchLifecycle'
import type { LobbySeat } from './vibe/vibeLobby'
import { useGame } from '../core/local/useGame'
import { useLotusGame } from '../variants/lotus/lotusGame'
import { startHostGame } from './host/hostGameRunner'
import { RemotePlayerController } from './host/remotePlayerController'
import { LotusRemotePlayerController } from './host/lotusRemotePlayerController'
import type { SnapshotSource } from './host/localStateToSnapshot'
import {
  mapPlayersToLocal,
  mapRoundResultToLocal,
  mapWinPresentationToLocal,
  toLocalSeat,
} from './protocol/mapper'

const MATCH_NAMES = { east: '东风场', hanchan: '半庄场' }

/** 房主自视：把远程动作消息映射到本地权威引擎的动作方法（房主自己就是权威，不走网络）。 */
function sendToEngine(game: GamePort, message: RemotePlayerActionMessage) {
  switch (message.type) {
    case 'discard':
      game.userDiscard(message.handIndex)
      return
    case 'pass':
      game.userPass()
      return
    case 'claim':
      if (message.action === 'peng') game.userPeng()
      else if (message.action === 'gang') game.userGangFromDiscard()
      else if (message.action === 'chi') game.capabilities.value.chi?.choose(message.optionIndex ?? 0)
      return
    case 'gang':
      if (message.kind === 'wind') game.capabilities.value.windKong?.execute()
      else game.userGang(message.tile)
      return
    case 'hu':
      game.userHu()
      return
  }
}

/** 仍需等待「下一局确认」的远端 peer：排除已被 AI 接管（掉线）的座位——
 * 否则掉线玩家永远不会发 continue，全员卡死在「已确认，等待其他玩家」。 */
export function liveContinuePeers(seatByPeer: Map<string, number>, aiControlledSeats: Set<number>): string[] {
  return [...seatByPeer.keys()].filter((peerId) => {
    const seat = seatByPeer.get(peerId)
    return !(seat != null && aiControlledSeats.has(seat))
  })
}

interface UseVibeRemoteGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
}

export function useVibeRemoteGame({ playSound = () => {}, playSoundAndWait = async () => {} }: UseVibeRemoteGameOptions = {}) {
  const sessionStore = createRemoteSessionStore()
  const state = createRemoteGameState({
    guestId: sessionStore.loadGuestId() || '',
  })
  const {
    sessionStatus, sessionError, roomId, mySeat, nickname, avatar, playerId,
    roomTimeLimit, rulesetId, autoPlay,
    phase, players, wallCount, wall, wallHeadDrawn, currentPlayer, selectedIndex,
    turnSeconds, lastDiscard, actionPrompt, announcement, tableActionEvent,
    scoreFlowEvent, result, winEffect, winPresentation, revealHands,
    winningPlayerIndex, round, dealer, honba, matchType, matchFinished,
    dealAnimation, openingStage, diceValues, diceThrowerIndex, userDrewThisTurn, waitingNextRound,
    secondDice, flipTile, jokerTiles, wildcardTiles, flipStack, openingStack, wallBreakIndex,
    turnCanHu, turnCanWindKong,
  } = state

  // SDK 大厅状态：isHost + LobbySeat 座位表（取代 isCreator/creatorSeat/rejoinCode）。
  const isHost = ref(false)
  const lobbySeats = ref<LobbySeat[]>([])

  // 房主对局引擎（开局后懒创建）：房主 UI 直接用它；客户端 UI 用快照状态。
  const hostGame = shallowRef<{
    game: GamePort & SnapshotSource
    stop(): void
    aiControlledSeats: Set<number>
    aiControlledSeatsVersion: { value: number }
    getLivePeerSeats(): Map<string, number>
    enableAIForSeat(seat: number): boolean
  } | null>(null)

  const roomSession = createVibeRoomSession({
    state: {
      roomId, mySeat, nickname, avatar, playerId,
      roomSeats: lobbySeats, sessionStatus, sessionError, rulesetId, matchType, isHost,
      phase,
    },
    loadSavedRoom: () => sessionStore.loadSession(),
    onStart: (room) => {
      if (!isHost.value) {
        // 客户端：开局由房主广播的 round_start/state_snapshot 驱动。
        // （房主失联检测在 watch(roomId) 加入房间时已注册——开局时才注册的话，
        // 大厅阶段房主离开没有任何检测，客户端只能干等「网络断开，正在重连」。）
        transport.open()
        return
      }
      const seatByPeer = new Map<string, number>()
      const seatNames = new Map<number, string>()
      const seatAvatars = new Map<number, string>()
      for (const seat of lobbySeats.value) {
        seatNames.set(seat.seat, seat.nickname)
        seatAvatars.set(seat.seat, seat.avatar)
        if (seat.seat > 0) seatByPeer.set(seat.peerId, seat.seat)
      }
      // 房主自视：无头引擎的 seat 0 快照/事件喂给本地 viewer，与客户端走同一套表现层。
      const onLocalSnapshot = (snapshot: ServerSnapshot) => snapshotReconciler.apply(snapshot)
      const onLocalEvent = (message: ServerMessage) => handleMessage(message)
      if (rulesetId.value === 'lotus-legacy') {
        hostGame.value = startHostGame({
          room,
          rulesetId: rulesetId.value,
          mode: matchType.value,
          seatByPeer,
          seatNames,
          seatAvatars,
          createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
          createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
          getSeatByPeer: () => new Map(lobbySeats.value.filter((s) => s.seat > 0).map((s) => [s.peerId, s.seat])),
          onLocalSnapshot,
          onLocalEvent,
        })
      } else {
        hostGame.value = startHostGame({
          room,
          rulesetId: rulesetId.value,
          mode: matchType.value,
          seatByPeer,
          seatNames,
          seatAvatars,
          createController: (r, peerId, onPending, onAI) => new RemotePlayerController(r, peerId, onPending, undefined, onAI),
          createGame: (controllers) => useGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
          getSeatByPeer: () => new Map(lobbySeats.value.filter((s) => s.seat > 0).map((s) => [s.peerId, s.seat])),
          onLocalSnapshot,
          onLocalEvent,
        })
      }
      // 临时诊断：定位「闲家方位是房主方位」的座位映射问题。
      console.log('[host] mySeat:', mySeat.value, 'seatByPeer:', [...seatByPeer.entries()].map(([p, s]) => `${p}->${s}`).join(' | '))
      // 房主动作改道本地权威引擎。
      sendAction = (message) => {
        const game = hostGame.value?.game
        if (game) sendToEngine(game, message)
      }
      // 回合续接：房主等所有「在线」玩家确认「下一局」后才推进；掉线被 AI 接管的
      // 座位不再要求确认（否则永远等不到，卡在「已确认，等待其他玩家」）。
      const continueReady = new Set<string>()
      let hostReadyNext = false
      let continueSafety: ReturnType<typeof setTimeout> | null = null
      function clearContinueSafety() {
        if (continueSafety != null) { window.clearTimeout(continueSafety); continueSafety = null }
      }
      function maybeAdvanceRound() {
        const aiSeats = hostGame.value?.aiControlledSeats ?? new Set<number>()
        // 用引擎当前的真人座位表（seatStates，重连后 peerId 已 retarget）而非大厅
        // 静态表：重连客户端发来的 continue 携带新 peerId，若按大厅旧 peerId 判定，
        // 永远等不到确认 → 全员卡死在「已确认，等待其他玩家」。
        const liveSeats = hostGame.value?.getLivePeerSeats()
          ?? new Map(lobbySeats.value.filter((s) => s.seat > 0).map((s) => [s.peerId, s.seat]))
        const livePeers = liveContinuePeers(liveSeats, aiSeats)
        // 临时诊断：定位「已确认，等待其他玩家」卡死——打印在等谁、谁已确认。
        console.log('[host] continue: ready=', hostReadyNext, 'live=', livePeers.join(','), 'confirmed=', [...continueReady].join(','), 'ai=', [...aiSeats].join(','))
        if (hostReadyNext && livePeers.every((peerId) => continueReady.has(peerId))) {
          hostReadyNext = false
          continueReady.clear()
          clearContinueSafety()
          hostGame.value?.game.nextRound()
        }
      }
      // 等待确认期间有人被 AI 接管（掉线超时）→ 立即重新评估屏障，不能干等。
      watch(() => hostGame.value?.aiControlledSeatsVersion.value ?? 0, () => maybeAdvanceRound())
      continueAction = () => {
        hostReadyNext = true
        // 兜底：超过 20s 仍未确认的座位视为掉线（局末断线的玩家此后引擎再无请求，
        // 15s 挂起超时永远不会触发，座位不会进 AI 名单）→ 强制 AI 接管并重新评估，
        // 避免全员永久卡在「已确认，等待其他玩家」。
        clearContinueSafety()
        continueSafety = window.setTimeout(() => {
          continueSafety = null
          if (!hostReadyNext) return
          const aiSeats = hostGame.value?.aiControlledSeats ?? new Set<number>()
          const liveSeats = hostGame.value?.getLivePeerSeats() ?? new Map<string, number>()
          for (const [peerId, seat] of liveSeats) {
            if (!aiSeats.has(seat) && !continueReady.has(peerId)) {
              hostGame.value?.enableAIForSeat(seat)
            }
          }
          // enableAIForSeat 触发 aiControlledSeatsVersion → watch → maybeAdvanceRound。
        }, 20000)
        maybeAdvanceRound()
      }
      room.onMessage((message, fromPeerId) => {
        if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'continue') {
          continueReady.add(fromPeerId)
          maybeAdvanceRound()
        }
      })
    },
    onClosed: () => {
      void leaveRoom()
    },
  })

  // ── 传输层：join 后由 vibeRoomTransport 绑定一次 ──
  const transport = createVibeRoomTransport({
    getRoom: () => roomSession.getRoom(),
    onMessage: handleMessage,
  })
  const wsStatus = transport.status
  const signalQuality = transport.signalQuality

  // 动作发送：客户端走传输层；房主在 onStart 后改道本地引擎（房主自己就是权威）。
  let sendAction: (message: RemotePlayerActionMessage) => void = (message) => transport.send(message)

  // 房主自视：快照不带 actionPrompt，本家「碰/杠/胡/吃」提示由引擎镜像进本地 viewer。
  watch(() => hostGame.value?.game.actionPrompt.value, (prompt) => {
    if (isHost.value) actionPrompt.value = prompt ?? null
  })

  // 房主自视：引擎无头不计时，本家回合/提示倒计时由 viewer 表现层计时（超时自动出牌/过牌），
  // 与客户端 requestCoordinator 的 12s 倒计时对齐（发牌动画结束后才真正看到回合，故不能在引擎里起跑）。
  let hostCountdownHandle: number | null = null
  function clearHostCountdown() {
    if (hostCountdownHandle != null) {
      globalThis.clearInterval(hostCountdownHandle)
      hostCountdownHandle = null
    }
    turnSeconds.value = 0
  }
  function startHostCountdown(onExpire: () => void) {
    clearHostCountdown()
    turnSeconds.value = 12
    hostCountdownHandle = globalThis.setInterval(() => {
      if (!isHost.value) {
        clearHostCountdown()
        return
      }
      turnSeconds.value -= 1
      if (turnSeconds.value === 3) playSound('didu.ogg')
      if (turnSeconds.value <= 0) {
        clearHostCountdown()
        onExpire()
      }
    }, 1000)
  }
  watch(() => [phase.value, currentPlayer.value, actionPrompt.value] as const, () => {
    if (!isHost.value) return
    const hostTurn = phase.value === 'discard' && currentPlayer.value === 0
    const hostPrompt = phase.value === 'prompt' && actionPrompt.value != null
    if (hostTurn) {
      const last = Math.max(0, (players[0]?.hand.length ?? 1) - 1)
      startHostCountdown(() => sendAction({ type: 'discard', handIndex: last }))
    } else if (hostPrompt) {
      startHostCountdown(() => sendAction({ type: 'pass' }))
    } else {
      clearHostCountdown()
    }
  })

  // ── 内部：定时器 / 延迟队列 ──
  const timers = new Set<number>()

  // ── 座位映射（服务端/房主座位 → 本地索引）────────────────────
  const mySeatLocal = computed(() => (mySeat.value >= 0 ? mySeat.value : -1))
  const toLocal = (serverSeat: number) => toLocalSeat(serverSeat, mySeatLocal.value)

  const settlementTimeline = createSettlementTimeline({
    state: { phase, result, winEffect, winPresentation, revealHands, winningPlayerIndex },
    mapResult: (value) => mapResult(value),
    mapPresentation: (value) => mapWinPresentation(value),
    toLocalSeat: toLocal,
    playSound,
  })
  const openingTimeline = createOpeningTimeline({
    state: {
      phase, players, wall, wallCount, wallHeadDrawn, currentPlayer, selectedIndex,
      actionPrompt, lastDiscard, result, winEffect, winPresentation, revealHands,
      winningPlayerIndex, round, dealer, honba, diceValues, secondDice, flipTile, jokerTiles, wildcardTiles, flipStack, openingStack, wallBreakIndex, diceThrowerIndex, openingStage, dealAnimation, announcement,
    },
    toLocalSeat: toLocal,
    mapPlayers: (value) => rotatePlayers(value),
    playSound,
    playSoundAndWait,
    send: transport.send,
    onFinished: applyBufferedAfterOpening,
  })
  const snapshotReconciler = createSnapshotReconciler({
    state,
    getLocalSeat: () => mySeatLocal.value,
    isShowingRoundResult,
    opening: openingTimeline,
    settlement: settlementTimeline,
    clearCountdown,
    onFinishedSnapshot: clearPendingRequest,
    playSound,
    later,
    isLocalAuthority: () => isHost.value,
  })
  const transientEventPresenter = createTransientEventPresenter({
    state,
    getLocalSeat: () => mySeatLocal.value,
    isOpening: openingTimeline.isRunning,
    showServerAnnouncement: snapshotReconciler.showAnnouncement,
    playSound,
    later,
  })

  const user = computed(() => players[0])
  const isUserTurn = computed(() => currentPlayer.value === 0 && phase.value === 'discard')
  const { userCanHu, userKongs, userCurrentWaits, userTingOptions, userDiscardWaits } = createPlayerSelectors({
    players,
    user,
    phase,
    isUserTurn,
    userDrewThisTurn,
    selectedIndex,
    getRuleset: () => (rulesetId.value === 'lotus-legacy' ? LOTUS_RULESET : undefined),
    getJokers: () => jokerTiles.value,
    getWildcards: () => wildcardTiles.value,
  })
  const remoteUserKongs = computed<TileType[]>(() => {
    if (!user.value || !isUserTurn.value || !userDrewThisTurn.value) return []
    const concealed = rulesetId.value === 'lotus-legacy'
      ? LOTUS_RULESET.win.concealedKongs(user.value.hand, { jokers: jokerTiles.value })
      : userKongs.value
    const added = user.value.melds
      .filter((meld) => meld.type === 'peng' && user.value!.hand.includes(meld.tile))
      .map((meld) => meld.tile)
    return [...new Set([...concealed, ...added])]
  })
  // 房主自己的回合不会经过 requestCoordinator，因此快照状态里没有
  // turn_request 携带的 drawnThisTurn/canHu。换庄重新开局后，若继续用
  // viewer 的 userCanHu，房主可能看不到胡按钮，点击也会被拦截；房主
  // 必须直接读取权威引擎的判定。客户端则继续使用请求/快照状态。
  const remoteUserCanHu = computed(() => isHost.value
    ? (hostGame.value?.game.userCanHu.value ?? false)
    : (turnCanHu.value || userCanHu.value))
  // 房主自己的回合同样不走 requestCoordinator，风杠可用性必须镜像权威引擎的判定
  // （否则房主永远收不到 turn_request 的 canWindKong，风杠按钮要么不出现要么乱出现）。
  const remoteUserHasWindKong = computed(() => isHost.value
    ? (hostGame.value?.game.capabilities.value.windKong?.available ?? false)
    : turnCanWindKong.value)
  const windName = computed(() => (round.value > 4 ? '南' : '东'))
  const handNumber = computed(() => ((round.value - 1) % 4) + 1)
  const roundLabel = computed(() => `${windName.value}${handNumber.value}局`)
  const matchName = computed(() => MATCH_NAMES[matchType.value])
  const standings = computed(() => players
    .map((player, index) => ({ ...player, playerIndex: index }))
    .sort((a, b) => b.score - a.score || a.playerIndex - b.playerIndex)
    .map((player, index) => ({ ...player, rank: index + 1 })))
  const remoteActionController = createRemoteActionController({
    state,
    isUserTurn: () => isUserTurn.value,
    canUserHu: () => remoteUserCanHu.value,
    getUser: () => user.value,
    getUserKongs: () => remoteUserKongs.value,
    clearCountdown,
    playSound,
    send: (message) => sendAction(message),
  })
  const {
    selectTile,
    clearUserSelection,
    userDiscard,
    pickDiscard: autoPickDiscard,
    toggleAutoPlay,
    userPass,
    userPeng,
    userChi,
    userGangFromDiscard,
    userGang,
    userWindKong,
    userHu,
  } = remoteActionController

  const requestCoordinator = createRequestCoordinator({
    state,
    isBlocked: () => isShowingRoundResult() || openingTimeline.isRunning(),
    isUserTurn: () => isUserTurn.value,
    canUserHu: () => remoteUserCanHu.value,
    getUserHandLength: () => user.value?.hand.length ?? 0,
    toLocalSeat: toLocal,
    announce: transientEventPresenter.announce,
    playSound,
    later,
    actions: {
      discard: remoteActionController.userDiscard,
      pass: remoteActionController.userPass,
      hu: remoteActionController.userHu,
      pickDiscard: remoteActionController.pickDiscard,
    },
  })
  // 回合续接：客户端发 continue 给房主；房主直接推进本地引擎。
  let continueAction: () => void = () => transport.send({ type: 'continue' })
  const matchLifecycle = createRemoteMatchLifecycle({
    state,
    isShowingRoundResult,
    clearTimers,
    opening: openingTimeline,
    settlement: settlementTimeline,
    snapshots: snapshotReconciler,
    requests: requestCoordinator,
    transientEvents: transientEventPresenter,
    sendContinue: () => continueAction(),
    refreshRoom: () => {},
  })
  const { nextRound, returnToLobby: lifecycleReturnToLobby } = matchLifecycle
  function returnToLobby() {
    if (isHost.value) hostGame.value?.game.returnToLobby()
    lifecycleReturnToLobby()
  }

  function clearPendingRequest() {
    requestCoordinator.clearPending()
  }

  function later(callback: () => void, delay: number) {
    const id = window.setTimeout(() => {
      timers.delete(id)
      callback()
    }, delay)
    timers.add(id)
    return id
  }

  function clearTimers() {
    timers.forEach((id) => window.clearTimeout(id))
    timers.clear()
    requestCoordinator.clearCountdown()
    openingTimeline.cancel()
    settlementTimeline.cancel()
  }

  // ── 刷新重进的自愈：SDK 刷新后可能残留旧 RTCPeerConnection（setRemoteDescription
  // on closed PC 报错），数据通道建不起来 → 收不到任何消息。检测「已加入房间但连座位
  // 都没拿到（mySeat < 0，即完全没收到过房主消息）」→ 自动 leave + 重新 join（最多 2 次）。
  // 注意：拿到座位（mySeat >= 0）说明通道可用、已正常进房，绝不能重试（每次重试会换
  // 新 peerId，反而打断昵称兜底恢复）。房主在大厅时客户端本就停在 lobby，也属正常。
  // 重试耗尽仍失败：房间大概率已失效（对局散场/全员离开，旧房间号在 SDK 侧已不存在）——
  // 继续重试毫无意义，清除会话并提示，让用户回大厅重新创建/加入。
  const rejoining = ref(false)
  let rejoinRetries = 0
  function scheduleRejoinRetry() {
    const retry = () => {
      if (!roomId.value || mySeat.value >= 0 || state.matchFinished.value || isHost.value) return
      rejoinRetries += 1
      if (rejoinRetries > 2) {
        rejoining.value = false
        clearSavedSession()
        state.sessionError.value = '房间已失效或无法连接，请重新创建或加入房间'
        return
      }
      rejoining.value = true
      console.warn(`[client] 尝试重新加入房间（第 ${rejoinRetries} 次）——重进后连座位都没收到`)
      void roomSession.leaveRoom()
      later(() => { void roomSession.resumeSession() }, 1500)
      // 12s 再查：SDK relay 切换/消息排队时 roster 可能迟到，过短的间隔会自伤——
      // 每次重进都是新 peerId（旧连接在 SDK 里还要挂 120s 才释放），重进越多连接越乱。
      later(retry, 12000)
    }
    later(retry, 12000)
  }
  function resetRejoinRetry() {
    rejoinRetries = 0
    rejoining.value = false
  }
  // 重进成功（拿到座位或成为房主）→ 关闭「尝试重新加入」提示。
  watch([mySeat, isHost], () => {
    if (mySeat.value >= 0 || isHost.value) rejoining.value = false
  })

  // 「已确认」失联自愈：客户端确认「下一局」后 waitingNextRound=true，若长时间收不到
  // 推进信号（round_start → handleRoundStart 会把它清回 false），说明与房主的通道断了
  // （SDK relay 协商失败/消息丢失），round_start 永远到不了 → 客户端永远卡在
  // 「已确认，等待其他玩家」。超时自动重进：快照会重同步当前局面、waitingNextRound
  // 随 resetAll 清除，客户端回到新一局而不是干等。
  let confirmRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  function clearConfirmRecovery() {
    if (confirmRecoveryTimer != null) {
      window.clearTimeout(confirmRecoveryTimer)
      confirmRecoveryTimer = null
    }
  }
  watch(() => state.waitingNextRound.value, (waiting) => {
    if (!waiting || isHost.value || !roomId.value) {
      clearConfirmRecovery()
      return
    }
    clearConfirmRecovery()
    confirmRecoveryTimer = window.setTimeout(() => {
      confirmRecoveryTimer = null
      if (!state.waitingNextRound.value || state.matchFinished.value) return
      if (!roomId.value || isHost.value) return
      console.warn('[client] 确认后长时间未收到推进信号（通道可能断开），自动重进')
      rejoinRetries += 1
      if (rejoinRetries > 2) {
        rejoining.value = false
        clearSavedSession()
        state.sessionError.value = '房间已失效或无法连接，请重新创建或加入房间'
        return
      }
      rejoining.value = true
      void roomSession.leaveRoom()
      later(() => { void roomSession.resumeSession() }, 1000)
    }, 20000)
  })

  function clearCountdown() {
    requestCoordinator.clearCountdown()
    clearHostCountdown()
  }

  function isShowingRoundResult() {
    return phase.value === 'win-effect'
      || phase.value === 'revealing'
      || (phase.value === 'settled' && result.value != null)
  }

  function mapResult(raw: RoundResult | null): RoundResult | null {
    return mapRoundResultToLocal(raw, mySeatLocal.value)
  }

  function mapWinPresentation(wp: WinPresentation | null): WinPresentation | null {
    return mapWinPresentationToLocal(wp, mySeatLocal.value)
  }

  function rotatePlayers(snapshotPlayers: ServerPlayerDto[]) {
    return mapPlayersToLocal(snapshotPlayers, mySeatLocal.value)
  }

  function applyBufferedAfterOpening() {
    snapshotReconciler.flush()
    requestCoordinator.flush()
  }

  function handleError(code: string) {
    if (code === 'STALE_ACTION' || code === 'INVALID_ACTION') return
    sessionError.value = code
  }

  // 加入房间后保存会话（刷新页面据此自动重进）；模式/规则由快照/元数据校准后刷新。
  watch([roomId, matchType, rulesetId], () => {
    if (!roomId.value) return
    sessionStore.saveSession({
      roomId: roomId.value,
      rejoinCode: '',
      nickname: nickname.value,
      playerId: playerId.value,
      mode: matchType.value,
      rulesetId: rulesetId.value,
    })
  })

  // 重连/加入后绑定传输层：对局进行中刷新页面重进时没有 lobby_start（onStart 里的
  // transport.open() 不触发），必须在此挂上 room.onMessage 才能收到快照/turn_request。
  // 客户端角色有效；房主保持不绑定（房主自视走 onLocalSnapshot/onLocalEvent）。
  // 同时注册房主失联检测：随「加入房间」生效（大厅/对局都覆盖），开局后才注册的话
  // 大厅阶段房主离开没有检测，客户端只能干等「网络断开，正在重连」。
  watch(roomId, (value) => {
    if (value && !isHost.value) {
      transport.open()
      const room = roomSession.getRoom()
      if (room) bindHostGoneDetection(room)
    }
  })

  // ── 消息分发（客户端：无 rejoin 握手，mySeat 由大厅 roster 分配）──
  // 重进标记：对局中重新加入（收到 rejoin_ok）置 true，下一个 round_start 用
  // instant（跳过发牌动画）并清除——否则重进玩家照常播 8s 动画，动画期间缓存的
  // turn_request 响应晚于房主掉线超时 → 在线玩家被误判「掉线 AI 代打」（AI 夺舍）。
  const rejoinedMidMatch = ref(false)
  const serverMessageRouter = createServerMessageRouter({
    rejoin_ok: (msg) => {
      // 刷新页面重进：房主补发的座位身份 → 恢复本家座位映射（对局进行中快照即重同步）。
      state.mySeat.value = msg.seat
      if (msg.roomId) state.roomId.value = msg.roomId
      state.sessionStatus.value = 'connected'
      rejoinedMidMatch.value = true
    },
    rejoin_err: () => {},
    state_snapshot: (msg) => snapshotReconciler.apply(msg),
    round_start: (msg) => {
      matchLifecycle.handleRoundStart(msg, { instant: rejoinedMidMatch.value })
      rejoinedMidMatch.value = false
    },
    turn_request: requestCoordinator.apply,
    claim_request: requestCoordinator.apply,
    rob_kong_request: requestCoordinator.apply,
    table_action: transientEventPresenter.handleTableAction,
    score_flow: transientEventPresenter.handleScoreFlow,
    announcement: transientEventPresenter.handleAnnouncement,
    hand_result: (msg) => {
      if (isShowingRoundResult() || result.value || !players.length || openingTimeline.isRunning()) return
      phase.value = 'revealing'
      revealHands.value = true
      const mapped = mapResult(msg.result)
      const winType = mapped?.winType
      const isDiscardStyle = winType === 'discard' || winType === 'robbed-kong' || winType === 'dihu'
      playSound(isDiscardStyle ? 'hu.mp3' : 'zimo.mp3')
      later(() => {
        phase.value = 'settled'
        result.value = mapped
      }, 600)
    },
    continue_prompt: () => {},
    match_finished: (msg) => matchLifecycle.finishMatch(msg.finalScores),
    room_closed: () => { void leaveRoom() },
    pong: () => {},
    error: (msg) => handleError(msg.code),
  })

  // 房主失联判定定时器（客户端）：加入房间即注册（见 bindHostGoneDetection）；
  // 收到房主任何业务消息（handleMessage）即取消——「房主恢复」以收到消息为准，
  // SDK 的 connecting/join 事件只是自身重连流程，不能当作恢复。
  let hostGoneTimer: ReturnType<typeof setTimeout> | null = null
  let hostGoneBoundRoom: VibeHubSDK.Room | null = null
  function clearHostGoneTimer() {
    if (hostGoneTimer != null) {
      window.clearTimeout(hostGoneTimer)
      hostGoneTimer = null
    }
  }

  /** 房主失联检测（客户端）：对局中 8s 无消息 → 结束对局；大厅 4s → 离开房间并提示。
   * 必须随「加入房间」注册（watch(roomId)），不能只在开局（onStart）注册——否则大厅
   * 阶段房主离开没有任何检测，客户端只能干等「网络断开，正在重连」几十秒。 */
  function bindHostGoneDetection(room: VibeHubSDK.Room) {
    if (hostGoneBoundRoom === room) return
    hostGoneBoundRoom = room
    room.onPeer((event) => {
      if (event.type === 'error' || event.type === 'relay') return
      const hostSeat = lobbySeats.value.find((seat) => seat.seat === 0)
      if (!hostSeat || event.id !== hostSeat.peerId) return
      if (state.matchFinished.value) return
      const finishMatch = () => {
        matchLifecycle.finishMatch(players.map((player) => ({
          seat: player.seat,
          name: player.name,
          score: player.score,
        })))
        transientEventPresenter.announce('房主掉线，对局结束', 'gold')
      }
      const leaveLobby = () => {
        state.sessionError.value = '房主已关闭房间'
        void leaveRoom()
      }
      if (event.type === 'leave') {
        // 房主主动离开（含大厅解散房间）：立即判定，不等超时。
        clearHostGoneTimer()
        if (phase.value === 'lobby') leaveLobby()
        else finishMatch()
        return
      }
      if (event.type === 'reconnecting') {
        // 房主失联：进入重连等待（对局 30s / 大厅 4s），超时仍无恢复即判定掉线。
        // 对局给 30s 是给房主「重新接管」的机会：房主页面还开着（网络抖动/断线）时
        // SDK 会重连，引擎状态还在房主内存里——期间收到房主任何业务消息（快照/请求）
        // 就取消判定（handleMessage），房主回来即恢复对局。只有刷新页面（引擎状态丢失）
        // 或彻底失联 30s，才结束对局。
        if (hostGoneTimer == null) {
          hostGoneTimer = window.setTimeout(() => {
            hostGoneTimer = null
            if (state.matchFinished.value) return
            if (phase.value === 'lobby') leaveLobby()
            else finishMatch()
          }, phase.value === 'lobby' ? 4000 : 30000)
        }
      }
    })
  }

  function handleMessage(raw: unknown) {
    // 收到房主的业务消息（快照/请求/announcement/roster）→ 房主在线，取消掉线判定。
    clearHostGoneTimer()
    serverMessageRouter(raw)
  }

  function closeConnection() {
    transport.close()
    clearTimers()
  }

  function resetAll() {
    matchLifecycle.resetAll()
  }

  async function leaveRoom() {
    closeConnection()
    resetAll()
    roomSession.leaveRoom()
    // 主动退出房间 → 清除保存的会话：否则刷新页面、重新登录后 watch(vibeUser)
    // 会触发 resumeSession 自动加入旧房间（「退出了房间，登录后怎么又进旧房」）。
    clearSavedSession()
  }

  /** 房主关闭房间（closeRoom 也走 leaveRoom 的清理路径）。 */
  async function closeRoom() {
    await roomSession.closeRoom()
    await leaveRoom()
  }

  // 暴露给 lobby 控制器的房间动作：主动退出/关闭房间时清除保存的会话（内部重进路径
  // 用原始 roomSession，保留会话以便自动重进）。
  // sessionVersion 让 savedSessionExists 响应式：清会话后 App.vue 的 watch(vibeUser)
  // 立即读到「已无会话」，不会在退出房间后重新登录时又自动加入旧房间。
  const sessionVersion = ref(0)
  const savedSessionExists = computed(() => {
    void sessionVersion.value
    return sessionStore.loadSession() != null
  })
  function clearSavedSession() {
    sessionStore.clearSession()
    sessionVersion.value += 1
  }
  const remoteActions = {
    ...roomSession,
    async leaveRoom() {
      await roomSession.leaveRoom()
      clearSavedSession()
    },
    async closeRoom() {
      await roomSession.closeRoom()
      clearSavedSession()
    },
  }

  function cleanup() {
    hostGame.value?.stop()
    closeConnection()
    clearTimers()
  }
  const instance = getCurrentInstance()
  if (instance) onBeforeUnmount(cleanup)

  return defineGamePort({
    // 远程会话
    sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, avatar, playerId,
    isHost, hostGame, roomSeats: lobbySeats, roomTimeLimit, waitingNextRound, rulesetId,
    savedSessionExists,
    scheduleRejoinRetry,
    resetRejoinRetry,
    rejoining,
    secondDice, flipTile, jokerTiles, wildcardTiles, flipStack, openingStack, wallBreakIndex,
    signalQuality, autoPlay, toggleAutoPlay,
    remoteActions,
    // 游戏状态（useGame 兼容接口）
    phase, players, wall, wallHeadDrawn, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
    actionPrompt, announcement, tableActionEvent, scoreFlowEvent, result, winEffect,
    winPresentation, revealHands, winningPlayerIndex,
    round, dealer, user, isUserTurn, userCanHu: remoteUserCanHu,
    matchType, matchName, matchFinished, honba, roundLabel, standings,
    dealAnimation, openingStage, diceValues, diceThrowerIndex, userCurrentWaits, userTingOptions, userDiscardWaits,
    userKongs: remoteUserKongs,
    capabilities: computed(() => ({
      chi: { choose: userChi },
      windKong: { available: remoteUserHasWindKong.value, execute: userWindKong },
      lotusTable: {
        flipTile: flipTile.value,
        jokerTiles: jokerTiles.value,
        wildcardTiles: wildcardTiles.value,
        wallBreakIndex: wallBreakIndex.value,
        flipStack: flipStack.value,
      },
    })), startGame: resetAll, selectTile, clearUserSelection, userDiscard, userPass, userPeng,
    userGangFromDiscard, userGang, userChi, userWindKong, userHu,
    nextRound, returnToLobby, tileName, debugPreviewWin: () => {},
  })
}
