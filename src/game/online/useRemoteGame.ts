// 远程对局 composable —— 与 useGame 返回完全兼容的接口，但状态由服务端快照驱动
//
// 职责划分：
// - REST（api/roomApi.ts）管理房间资源，session/remoteRoomLifecycle.ts 编排生命周期
// - WebSocket 只做实时对局：state_snapshot 为唯一真源，turn/claim/rob 请求驱动交互
//
// 座位旋转：服务端座位是权威索引，客户端固定把「本家」排到 players[0]（桌面底部）。
// 所有座位敏感字段（currentPlayer / dealer / lastDiscard / tableAction / scoreFlow /
// result / winPresentation）在应用时统一经 toLocal() 映射。
//
// 结算展示：服务端无条件推进场次，客户端在赢牌动画 / 结算弹窗期间延迟应用
// 后续快照与请求分别由 reconciler / requestCoordinator 缓冲，用户点「继续」后再落地。
import { computed, getCurrentInstance, onBeforeUnmount } from 'vue'
import { API_BASE } from './api/httpClient'
import { defineGamePort } from '../core/gamePort'
import type { RoundResult } from '../core/gamePort'
import type { ActionPrompt } from '../core/playerController'
import { concealedKongs, isWinningHand, matchingCount, waitingTiles } from '../core/rules'
import { TILE_TYPES, tileName } from '../core/tiles'
import type { GamePlayer, MatchType, ScoreDelta, ScoreFlowEvent, TableActionEvent, TileType, WinPresentation } from '../core/types'
import type { ServerSnapshot } from './protocol/dto'
import type { RoundStartMessage } from './protocol/messages'
import { createRemoteSessionStore } from './session/remoteSessionStore'
import { createRoomSocketTransport } from './transport/roomSocket'
import { createRemoteRoomLifecycle } from './session/remoteRoomLifecycle'
import { createOpeningTimeline } from './presentation/openingTimeline'
import { createSettlementTimeline } from './presentation/settlementTimeline'
import { createRemoteGameState } from './state/remoteGameState'
import { createSnapshotReconciler } from './orchestration/snapshotReconciler'
import { createServerMessageRouter } from './orchestration/serverMessageRouter'
import { createRequestCoordinator } from './orchestration/requestCoordinator'
import { createRemoteActionController } from './orchestration/remoteActionController'
import {
  mapPlayersToLocal,
  mapRoundResultToLocal,
  mapScoreDeltasToLocal,
  mapTableActionToLocal,
  mapWinPresentationToLocal,
  toLocalSeat,
} from './protocol/mapper'

const WS_BASE = API_BASE.replace(/^http/, 'ws')
const MATCH_NAMES = { east: '东风场', hanchan: '半庄场' }

interface UseRemoteGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
}

export function useRemoteGame({ playSound = () => {}, playSoundAndWait = async () => {} }: UseRemoteGameOptions = {}) {
  const sessionStore = createRemoteSessionStore()
  const state = createRemoteGameState({
    guestId: sessionStore.loadGuestId() || '',
    storedSession: sessionStore.loadSession(),
  })
  const {
    sessionStatus, sessionError, roomId, mySeat, nickname, rejoinCode, playerId,
    creatorSeat, isCreator, roomSeats, roomTimeLimit, autoPlay, storedSession,
    phase, players, wallCount, wall, wallHeadDrawn, currentPlayer, selectedIndex,
    turnSeconds, lastDiscard, actionPrompt, announcement, tableActionEvent,
    scoreFlowEvent, result, winEffect, winPresentation, revealHands,
    winningPlayerIndex, round, dealer, honba, matchType, matchFinished,
    dealAnimation, openingStage, diceValues, userDrewThisTurn, waitingNextRound,
  } = state
  const roomSocket = createRoomSocketTransport({
    getUrl: () => roomId.value && rejoinCode.value
      ? `${WS_BASE}/ws/room/${encodeURIComponent(roomId.value)}?rejoin_code=${encodeURIComponent(rejoinCode.value)}`
      : null,
    onMessage: handleMessage,
  })
  const wsStatus = roomSocket.status
  const signalQuality = roomSocket.signalQuality

  // ── 内部：连接 / 定时器 / 延迟队列 ──
  let pendingRoundStart: RoundStartMessage | null = null
  const timers = new Set<number>()

  const roomLifecycle = createRemoteRoomLifecycle({
    state: {
      sessionStatus, sessionError, roomId, mySeat, nickname, rejoinCode, playerId,
      creatorSeat, isCreator, roomSeats, roomTimeLimit, storedSession,
      phase, matchType, matchFinished, players,
    },
    sessionStore,
    socket: roomSocket,
    closeConnection,
    resetGame: resetAll,
  })

  // ── 座位映射（服务端座位 → 本地索引）────────────────────
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
      winningPlayerIndex, round, dealer, honba, diceValues, openingStage, dealAnimation,
    },
    toLocalSeat: toLocal,
    mapPlayers: (value) => rotatePlayers(value),
    playSound,
    playSoundAndWait,
    send: roomSocket.send,
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

  const user = computed(() => players[0])
  const isUserTurn = computed(() => currentPlayer.value === 0 && phase.value === 'discard')
  const userCanHu = computed(() => Boolean(user.value)
    && isUserTurn.value
    && userDrewThisTurn.value
    && isWinningHand(user.value.hand, structuralMeldCount(user.value)))
  const userKongs = computed(() => {
    if (!user.value || !isUserTurn.value || !userDrewThisTurn.value) return []
    const concealed = concealedKongs(user.value.hand)
    const added = user.value.melds
      .filter((meld) => meld.type === 'peng' && user.value.hand.includes(meld.tile))
      .map((meld) => meld.tile)
    return [...new Set([...concealed, ...added])]
  })
  const windName = computed(() => (round.value > 4 ? '南' : '东'))
  const handNumber = computed(() => ((round.value - 1) % 4) + 1)
  const roundLabel = computed(() => `${windName.value}${handNumber.value}局`)
  const matchName = computed(() => MATCH_NAMES[matchType.value])
  const standings = computed(() => players
    .map((player, index) => ({ ...player, playerIndex: index }))
    .sort((a, b) => b.score - a.score || a.playerIndex - b.playerIndex)
    .map((player, index) => ({ ...player, rank: index + 1 })))
  const userCurrentWaits = computed(() => {
    if (!user.value || ['lobby', 'dealing', 'settled'].includes(phase.value)) return null
    return makeWaitInfo(waitingTiles(user.value.hand, structuralMeldCount(user.value)))
  })
  const userTingOptions = computed(() => {
    if (!user.value || !isUserTurn.value) return []
    const seen = new Set()
    return user.value.hand.flatMap((tile, index) => {
      if (seen.has(tile)) return []
      seen.add(tile)
      const info = discardWaitInfo(index)
      return info ? [info] : []
    })
  })
  const userDiscardWaits = computed(() => {
    if (selectedIndex.value < 0) return null
    const selectedTile = user.value?.hand[selectedIndex.value]
    return userTingOptions.value.find((option) => option.discard === selectedTile) ?? null
  })

  function structuralMeldCount(player: GamePlayer) {
    return player.melds.filter((meld) => meld.type !== 'flower').length
  }

  function visibleRemainingCount(tile: TileType) {
    let visible = matchingCount(user.value?.hand ?? [], tile)
    players.forEach((player) => {
      visible += matchingCount(player.discards, tile)
      player.melds.forEach((meld) => {
        visible += matchingCount(meld.tiles ?? [], tile)
      })
    })
    return Math.max(0, 4 - visible)
  }

  function makeWaitInfo(waits: TileType[], discard: TileType | null = null) {
    if (!waits.length) return null
    const tiles = waits.map((tile) => ({
      tile,
      remaining: visibleRemainingCount(tile),
    }))
    const allTiles = TILE_TYPES.filter((tile) => tile !== 'red')
    return {
      discard,
      tiles,
      any: waits.length === allTiles.length,
      remaining: tiles.reduce((total, item) => total + item.remaining, 0),
    }
  }

  function discardWaitInfo(handIndex: number) {
    const handAfterDiscard = user.value.hand.filter((_, index) => index !== handIndex)
    const waits = waitingTiles(handAfterDiscard, structuralMeldCount(user.value))
    return makeWaitInfo(waits, user.value.hand[handIndex])
  }

  const remoteActionController = createRemoteActionController({
    state,
    isUserTurn: () => isUserTurn.value,
    canUserHu: () => userCanHu.value,
    getUser: () => user.value,
    getUserKongs: () => userKongs.value,
    clearCountdown,
    playSound,
    send: roomSocket.send,
  })
  const {
    selectTile,
    clearUserSelection,
    userDiscard,
    pickDiscard: autoPickDiscard,
    toggleAutoPlay,
    userPass,
    userPeng,
    userGangFromDiscard,
    userGang,
    userHu,
  } = remoteActionController

  const requestCoordinator = createRequestCoordinator({
    state,
    isBlocked: () => isShowingRoundResult() || openingTimeline.isRunning(),
    isUserTurn: () => isUserTurn.value,
    canUserHu: () => userCanHu.value,
    getUserHandLength: () => user.value?.hand.length ?? 0,
    toLocalSeat: toLocal,
    announce,
    playSound,
    later,
    actions: {
      discard: remoteActionController.userDiscard,
      pass: remoteActionController.userPass,
      hu: remoteActionController.userHu,
      pickDiscard: remoteActionController.pickDiscard,
    },
  })

  function clearPendingRequest() {
    requestCoordinator.clearPending()
  }

  // ── 定时器工具 ─────────────────────────────────────────

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

  function announce(text: string, tone = 'gold') {
    announcement.value = { text, tone, id: Date.now() }
    later(() => {
      if (announcement.value?.text === text) announcement.value = null
    }, 1500)
  }

  // ── 结算展示 / 延迟队列 ────────────────────────────────

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

  // ── 快照应用 ───────────────────────────────────────────

  function rotatePlayers(snapshotPlayers: GamePlayer[]): GamePlayer[] {
    return mapPlayersToLocal(snapshotPlayers, mySeatLocal.value)
  }

  // ── 开局序列（对局开始 / 骰子投掷，纯表现层）────────────

  function handleRoundStart(msg: RoundStartMessage) {
    const alreadyConfirmed = waitingNextRound.value
    waitingNextRound.value = false
    // 结算展示期间到达（服务端兜底超时已推进）且本家尚未确认 → 延迟到点「继续」后应用；
    // 本家已确认（等齐其他玩家后服务端推进）→ 直接开局，startOpeningRound 会清理结算态。
    if (isShowingRoundResult() && !alreadyConfirmed) {
      pendingRoundStart = msg
      return
    }
    openingTimeline.start(msg)
  }

  function startOpeningRound(msg: RoundStartMessage) {
    openingTimeline.start(msg)
  }

  // ── 开局动画结束后的统一落地：先应用最新快照，再激活回合/请求 ──

  function applyBufferedAfterOpening() {
    snapshotReconciler.flush()
    requestCoordinator.flush()
  }

  // ── 瞬时事件（动画 / 播报 / 分数流水）─────────────────

  function handleTableAction(msg: { kind: 'table_action'; event: TableActionEvent }) {
    // 赢牌动作（self-draw / robbed-kong-win）：展示「自摸 / 抢杠胡」文字提示，
    // 但**不播音效**（zimo/hu 由结算表现时间线统一播放，避免双响）。
    // 开局动画期间（如四红中立即和牌）→ 等发牌结束的 settled 快照统一展示。
    const isWin = msg.event.type === 'self-draw' || msg.event.type === 'robbed-kong-win'
    if (openingTimeline.isRunning()) return
    const event = mapTableActionToLocal(msg.event, mySeatLocal.value)
    tableActionEvent.value = event
    later(() => {
      if (tableActionEvent.value?.id === event.id) tableActionEvent.value = null
    }, 1050)
    if (isWin) return   // 赢牌音效统一由结算表现时间线播放
    const sound: Record<string, string> = {
      peng: 'peng.mp3',
      'discard-gang': 'gang.mp3',
      'concealed-gang': 'gang.mp3',
      'added-gang': 'gang.mp3',
      'flower-gang': 'gang.mp3',
    }
    if (sound[event.type]) playSound(sound[event.type])
  }

  function handleScoreFlow(msg: { kind: 'score_flow'; deltas: ScoreDelta[] }) {
    if (!msg.deltas.length) return
    const event: ScoreFlowEvent = {
      id: Date.now(),
      deltas: mapScoreDeltasToLocal(msg.deltas, mySeatLocal.value),
    }
    scoreFlowEvent.value = event
    later(() => {
      if (scoreFlowEvent.value?.id === event.id) scoreFlowEvent.value = null
    }, 1050)
  }

  function handleAnnouncement(msg: { kind: 'announcement'; text: string; tone: string; id?: number }) {
    snapshotReconciler.showAnnouncement(msg)
  }

  function handleMatchFinished(msg: { kind: 'match_finished'; finalScores: Array<{ seat: number; name: string; score: number }> }) {
    settlementTimeline.cancel()
    snapshotReconciler.clearPending()
    requestCoordinator.clearPending()
    matchFinished.value = true
    phase.value = 'finished'
    result.value = null
    winEffect.value = null
    winPresentation.value = null
    revealHands.value = true
    winningPlayerIndex.value = -1
    if (msg.finalScores) {
      const scores = new Map(msg.finalScores.map((entry) => [entry.seat, entry.score]))
      players.forEach((player) => {
        const score = scores.get(player.seat)
        if (score != null) player.score = score
      })
    }
  }

  function handleError(code: string) {
    // STALE_ACTION / 超时竞态是正常现象：忽略，由后续快照自愈
    if (code === 'STALE_ACTION' || code === 'INVALID_ACTION') return
    sessionError.value = code
  }

  // ── 消息分发 ───────────────────────────────────────────

  const serverMessageRouter = createServerMessageRouter({
    rejoin_ok: (msg) => {
      roomId.value = msg.roomId
      mySeat.value = msg.seat
      nickname.value = msg.nickname
      rejoinCode.value = msg.rejoinCode
      matchType.value = msg.mode
      wsStatus.value = 'connected'
      sessionStatus.value = 'connected'
      sessionError.value = ''
      roomSocket.confirmSession()
      settlementTimeline.cancel()
      snapshotReconciler.clearPending()
      snapshotReconciler.resetDiscardDedup()
      requestCoordinator.clearPending()
      pendingRoundStart = null
      openingTimeline.cancel()
      waitingNextRound.value = false
      result.value = null
      winEffect.value = null
      winPresentation.value = null
      revealHands.value = false
      matchFinished.value = false
    },
    rejoin_err: (msg) => {
      wsStatus.value = 'closed'
      sessionError.value = msg.code
      roomLifecycle.clearSession()
    },
    state_snapshot: (msg) => snapshotReconciler.apply(msg),
    round_start: handleRoundStart,
    turn_request: requestCoordinator.apply,
    claim_request: requestCoordinator.apply,
    rob_kong_request: requestCoordinator.apply,
    table_action: handleTableAction,
    score_flow: handleScoreFlow,
    announcement: handleAnnouncement,
    hand_result: (msg) => {
      // settled 快照是主路径；这里只兜底断线边缘丢快照的情况。
      if (isShowingRoundResult() || result.value || !players.length || openingTimeline.isRunning()) return
      phase.value = 'revealing'
      revealHands.value = true
      const mapped = mapResult(msg.result)
      playSound('zimo.mp3')
      later(() => {
        phase.value = 'settled'
        result.value = mapped
      }, 600)
    },
    continue_prompt: () => {},
    match_finished: handleMatchFinished,
    room_closed: () => { void roomLifecycle.leaveRoom() },
    pong: () => {},
    error: (msg) => handleError(msg.code),
  })

  function handleMessage(raw: unknown) {
    serverMessageRouter(raw)
  }

  function closeConnection() {
    roomSocket.close()
    clearTimers()
  }

  // ── 重置 ───────────────────────────────────────────────

  function resetAll() {
    clearTimers()
    snapshotReconciler.reset()
    requestCoordinator.reset()
    pendingRoundStart = null
    openingTimeline.cancel()
    waitingNextRound.value = false
    openingStage.value = null
    phase.value = 'lobby'
    players.splice(0, players.length)
    wall.value = []
    wallHeadDrawn.value = 0
    wallCount.value = 0
    currentPlayer.value = -1
    selectedIndex.value = -1
    turnSeconds.value = 12
    lastDiscard.value = null
    actionPrompt.value = null
    announcement.value = null
    tableActionEvent.value = null
    scoreFlowEvent.value = null
    result.value = null
    winEffect.value = null
    winPresentation.value = null
    revealHands.value = false
    winningPlayerIndex.value = -1
    round.value = 1
    dealer.value = 0
    honba.value = 0
    matchFinished.value = false
    roomId.value = ''
    mySeat.value = -1
    nickname.value = ''
    rejoinCode.value = ''
    creatorSeat.value = null
    isCreator.value = false
    roomSeats.value = []
    roomTimeLimit.value = null
    sessionStatus.value = 'idle'
    sessionError.value = ''
  }

  // ── 场次推进（远程：服务端无条件推进，客户端只清除结算展示）──

  function nextRound() {
    settlementTimeline.cancel()
    if (matchFinished.value) return
    // 确认屏障：通知服务端本家已看完结算。**不清结算态**——对话框保留、
    // 按钮显示「等待其他玩家确定...」；等服务端等齐所有在线真人后推进，
    // round_start 到达时由 handleRoundStart → startOpeningRound 统一清理结算态。
    roomSocket.send({ type: 'continue' })
    waitingNextRound.value = true
    if (pendingRoundStart) {
      // 服务端兜底已推进，round_start 在结算展示期间已缓冲 → 直接落地
      const rs = pendingRoundStart
      pendingRoundStart = null
      waitingNextRound.value = false
      startOpeningRound(rs)
    }
    const pendingSnapshot = snapshotReconciler.takePending()
    if (pendingSnapshot) {
      // 若仍处结算态会再次缓冲，随下一局发牌动画结束后统一落地；滞留的旧结算快照丢弃
      if (!(pendingSnapshot.phase === 'settled' && pendingSnapshot.result)) {
        snapshotReconciler.apply(pendingSnapshot)
      }
    }
    requestCoordinator.flush()
  }

  function returnToLobby() {
    // 对局结束后回房间大厅：保留座位与 WS 连接（不释放座位、不散房），
    // 服务端房间仍在（finished），可再准备开局；房主解散用「关闭房间」。
    // 对局中返回大厅请用「退出对局」（房间生命周期的 leaveRoom）。
    if (!matchFinished.value) return
    settlementTimeline.cancel()
    clearCountdown()
    matchFinished.value = false
    result.value = null
    winEffect.value = null
    winPresentation.value = null
    revealHands.value = false
    winningPlayerIndex.value = -1
    waitingNextRound.value = false
    lastDiscard.value = null
    actionPrompt.value = null
    announcement.value = null
    tableActionEvent.value = null
    scoreFlowEvent.value = null
    selectedIndex.value = -1
    currentPlayer.value = -1
    wall.value = []
    wallHeadDrawn.value = 0
    wallCount.value = 0
    players.splice(0, players.length)
    phase.value = 'lobby'
    void roomLifecycle.refreshRoom()
  }

  function startGame() {
    // 远程模式下开局由 REST start 触发；此处仅复位到大厅（兼容 useGame 接口）
    resetAll()
  }

  function debugPreviewWin() {
    // 远程模式不提供本地调试胡牌
  }

  // ── 生命周期 ───────────────────────────────────────────

  function cleanup() {
    closeConnection()
    roomLifecycle.stopPolling()
    clearTimers()
  }
  const instance = getCurrentInstance()
  if (instance) onBeforeUnmount(cleanup)

  return defineGamePort({
    // 远程会话
    sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, rejoinCode,
    playerId, isCreator, creatorSeat, roomSeats, roomTimeLimit, waitingNextRound,
    signalQuality,   // 0-3 信号质量（越大连接越好）
    storedSession,   // 上次未完成对局（「继续对局」入口；null = 无）
    autoPlay, toggleAutoPlay,   // 自动打牌开关（多窗口联机测试/观战）
    remoteActions: roomLifecycle,
    // 游戏状态（useGame 兼容接口）
    phase, players, wall, wallHeadDrawn, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
    actionPrompt, announcement, tableActionEvent, scoreFlowEvent, result, winEffect,
    winPresentation, revealHands, winningPlayerIndex,
    round, dealer, user, isUserTurn, userCanHu,
    matchType, matchName, matchFinished, honba, roundLabel, standings,
    dealAnimation, openingStage, diceValues, userCurrentWaits, userTingOptions, userDiscardWaits,
    userKongs, startGame, selectTile, clearUserSelection, userDiscard, userPass, userPeng,
    userGangFromDiscard, userGang, userHu, nextRound, returnToLobby, tileName, debugPreviewWin,
  })
}
