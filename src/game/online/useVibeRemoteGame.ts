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
    sessionStatus, sessionError, roomId, mySeat, nickname, playerId,
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
  const hostGame = shallowRef<{ game: GamePort & SnapshotSource; stop(): void } | null>(null)

  const roomSession = createVibeRoomSession({
    state: {
      roomId, mySeat, nickname, playerId,
      roomSeats: lobbySeats, sessionStatus, sessionError, rulesetId, matchType, isHost,
    },
    onStart: (room) => {
      if (!isHost.value) {
        // 客户端：开局由房主广播的 round_start/state_snapshot 驱动。
        transport.open()
        return
      }
      const seatByPeer = new Map<string, number>()
      const seatNames = new Map<number, string>()
      for (const seat of lobbySeats.value) {
        seatNames.set(seat.seat, seat.nickname)
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
          createController: (r, peerId, onPending) => new LotusRemotePlayerController(r, peerId, onPending),
          createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
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
          createController: (r, peerId, onPending) => new RemotePlayerController(r, peerId, onPending),
          createGame: (controllers) => useGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
          onLocalSnapshot,
          onLocalEvent,
        })
      }
      // 房主动作改道本地权威引擎。
      sendAction = (message) => {
        const game = hostGame.value?.game
        if (game) sendToEngine(game, message)
      }
      continueAction = () => {
        hostGame.value?.game.nextRound()
      }
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
  const remoteUserCanHu = computed(() => (
    rulesetId.value === 'lotus-legacy' ? turnCanHu.value : (turnCanHu.value || userCanHu.value)
  ))
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

  // ── 消息分发（客户端：无 rejoin 握手，mySeat 由大厅 roster 分配）──
  const serverMessageRouter = createServerMessageRouter({
    rejoin_ok: () => {},
    rejoin_err: () => {},
    state_snapshot: (msg) => snapshotReconciler.apply(msg),
    round_start: matchLifecycle.handleRoundStart,
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

  function handleMessage(raw: unknown) {
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
    sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, playerId,
    isHost, hostGame, roomSeats: lobbySeats, roomTimeLimit, waitingNextRound, rulesetId,
    secondDice, flipTile, jokerTiles, wildcardTiles, flipStack, openingStack, wallBreakIndex,
    signalQuality, autoPlay, toggleAutoPlay,
    remoteActions: roomSession,
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
      windKong: { available: turnCanWindKong.value, execute: userWindKong },
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
