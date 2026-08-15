// VibeHub P2P 远程对局 composable（Phase 1/2 组装）：与 useRemoteGame 返回兼容的 GamePort，
// 但房间生命周期走 vibeRoomSession（SDK rooms + vibeLobby），实时对局走 vibeRoomTransport
// （SDK Room P2P 消息）。客户端角色复用 useRemoteGame 的快照驱动逻辑；房主角色另由
// hostGameRunner 组装（后续接入）。
//
// 与 useRemoteGame 的关键差异：
// - 无 rejoin_ok/rejoin_err 握手：mySeat 由大厅 roster 分配（vibeRoomSession）。
// - 座位表用 LobbySeat（含 peerId），isHost 取代 isCreator/creatorSeat。
// - 传输层在 join 后由 vibeRoomTransport 绑定一次（getRoom 返回已加入的 Room）。
import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef } from 'vue'
import { defineGamePort, type GamePort } from '../core/contracts/gamePort'
import type { RoundResult } from '../core/contracts/gamePort'
import { tileName } from '../core/rules/tiles'
import type { MatchType, TileType, WinPresentation } from '../core/contracts/types'
import { LOTUS_RULESET } from '../variants/lotus/lotusRules'
import { createPlayerSelectors } from '../core/selectors/playerSelectors'
import type { ServerPlayerDto } from './protocol/dto'
import { createRemoteSessionStore } from './session/remoteSessionStore'
import { createVibeRoomSession } from './vibe/vibeRoomSession'
import { createVibeRoomTransport } from './transport/vibeRoomTransport'
import { createOpeningTimeline } from './presentation/openingTimeline'
import { createSettlementTimeline } from './presentation/settlementTimeline'
import { createRemoteGameState } from './state/remoteGameState'
import { createSnapshotReconciler } from './orchestration/snapshotReconciler'
import { createServerMessageRouter } from './orchestration/serverMessageRouter'
import { createRequestCoordinator } from './orchestration/requestCoordinator'
import { createRemoteActionController } from './orchestration/remoteActionController'
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
      for (const seat of lobbySeats.value) {
        if (seat.seat > 0) seatByPeer.set(seat.peerId, seat.seat)
      }
      if (rulesetId.value === 'lotus-legacy') {
        hostGame.value = startHostGame({
          room,
          rulesetId: rulesetId.value,
          seatByPeer,
          createController: (r, peerId) => new LotusRemotePlayerController(r, peerId),
          createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: true }),
        })
      } else {
        hostGame.value = startHostGame({
          room,
          rulesetId: rulesetId.value,
          seatByPeer,
          createController: (r, peerId) => new RemotePlayerController(r, peerId),
          createGame: (controllers) => useGame({ remoteControllers: controllers, countdownEnabled: true }),
        })
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
    send: transport.send,
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
  const matchLifecycle = createRemoteMatchLifecycle({
    state,
    isShowingRoundResult,
    clearTimers,
    opening: openingTimeline,
    settlement: settlementTimeline,
    snapshots: snapshotReconciler,
    requests: requestCoordinator,
    transientEvents: transientEventPresenter,
    sendContinue: () => transport.send({ type: 'continue' }),
    refreshRoom: () => {},
  })
  const { nextRound, returnToLobby } = matchLifecycle

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
