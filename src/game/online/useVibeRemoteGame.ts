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
  const hostGame = shallowRef<{ game: GamePort & SnapshotSource; stop(): void; aiControlledSeats: Set<number> } | null>(null)

  const roomSession = createVibeRoomSession({
    state: {
      roomId, mySeat, nickname, avatar, playerId,
      roomSeats: lobbySeats, sessionStatus, sessionError, rulesetId, matchType, isHost,
    },
    loadSavedRoom: () => sessionStore.loadSession(),
    onStart: (room) => {
      if (!isHost.value) {
        // 客户端：开局由房主广播的 round_start/state_snapshot 驱动。
        transport.open()
        // P2：房主掉线 → 用当前分数结束对局，展示最终排名后可回大厅。
        // 真实 SDK 对「房主关闭页面」通常只报 reconnecting（重连中）而非立即 leave，
        // 因此持续失联超过阈值也判定房主掉线（leave 则立即判定）。
        const hostGoneAfter = (ms: number) => window.setTimeout(() => {
          if (state.matchFinished.value || phase.value === 'lobby') return
          matchLifecycle.finishMatch(players.map((player) => ({
            seat: player.seat,
            name: player.name,
            score: player.score,
          })))
          transientEventPresenter.announce('房主掉线，对局结束', 'gold')
        }, ms)
        let hostGoneTimer: ReturnType<typeof setTimeout> | null = null
        room.onPeer((event) => {
          if (event.type === 'error' || event.type === 'relay') return
          const hostSeat = lobbySeats.value.find((seat) => seat.seat === 0)
          if (!hostSeat || event.id !== hostSeat.peerId) return
          if (state.matchFinished.value || phase.value === 'lobby') return
          if (event.type === 'leave') {
            if (hostGoneTimer != null) { window.clearTimeout(hostGoneTimer); hostGoneTimer = null }
            matchLifecycle.finishMatch(players.map((player) => ({
              seat: player.seat,
              name: player.name,
              score: player.score,
            })))
            transientEventPresenter.announce('房主掉线，对局结束', 'gold')
            return
          }
          if (event.type === 'reconnecting') {
            // 房主失联：进入重连等待，超过阈值仍无恢复即判定掉线。
            if (hostGoneTimer == null) hostGoneTimer = hostGoneAfter(8000)
            return
          }
          if (event.type === 'join' || event.type === 'connecting') {
            // 房主恢复 → 取消掉线判定。
            if (hostGoneTimer != null) { window.clearTimeout(hostGoneTimer); hostGoneTimer = null }
          }
        })
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
      function maybeAdvanceRound() {
        const aiSeats = hostGame.value?.aiControlledSeats ?? new Set<number>()
        // 用实时大厅座位表（重连的客户端 peerId 会变，静态 seatByPeer 是开局快照，
        // 若按它判定，重连后座位既不在 AI 名单也等不到确认 → 下一局永远卡住）。
        const currentSeatByPeer = new Map(lobbySeats.value.filter((s) => s.seat > 0).map((s) => [s.peerId, s.seat]))
        const livePeers = liveContinuePeers(currentSeatByPeer, aiSeats)
        if (hostReadyNext && livePeers.every((peerId) => continueReady.has(peerId))) {
          hostReadyNext = false
          continueReady.clear()
          hostGame.value?.game.nextRound()
        }
      }
      continueAction = () => {
        hostReadyNext = true
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
  let rejoinRetries = 0
  function scheduleRejoinRetry() {
    const retry = () => {
      if (!roomId.value || mySeat.value >= 0 || state.matchFinished.value) return
      rejoinRetries += 1
      if (rejoinRetries > 2) return
      console.warn(`[client] 重进后连座位都没收到（数据通道可能未建立），重新加入（第 ${rejoinRetries} 次）`)
      void roomSession.leaveRoom()
      later(() => { void roomSession.resumeSession() }, 1500)
      later(retry, 8000)
    }
    later(retry, 8000)
  }
  function resetRejoinRetry() {
    rejoinRetries = 0
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
  watch(roomId, (value) => {
    if (value && !isHost.value) transport.open()
  })

  // ── 消息分发（客户端：无 rejoin 握手，mySeat 由大厅 roster 分配）──
  const serverMessageRouter = createServerMessageRouter({
    rejoin_ok: (msg) => {
      // 刷新页面重进：房主补发的座位身份 → 恢复本家座位映射（对局进行中快照即重同步）。
      state.mySeat.value = msg.seat
      if (msg.roomId) state.roomId.value = msg.roomId
      state.sessionStatus.value = 'connected'
    },
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
    sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, avatar, playerId,
    isHost, hostGame, roomSeats: lobbySeats, roomTimeLimit, waitingNextRound, rulesetId,
    savedSessionExists: sessionStore.loadSession() != null,
    scheduleRejoinRetry,
    resetRejoinRetry,
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
