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
import { computed, getCurrentInstance, onBeforeUnmount, ref } from 'vue'
import { API_BASE } from './api/httpClient'
import { defineGamePort } from '../core/contracts/gamePort'
import type { RoundResult } from '../core/contracts/gamePort'
import { tileName } from '../core/rules/tiles'
import type { MatchType, TableActionEvent, TileType, WinPresentation } from '../core/contracts/types'
import { LOTUS_RULESET } from '../variants/lotus/lotusRules'
import { createPlayerSelectors } from '../core/selectors/playerSelectors'
import type { ServerPlayerDto, ServerSnapshot } from './protocol/dto'
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
import { createTransientEventPresenter } from './presentation/transientEventPresenter'
import { createRemoteMatchLifecycle } from './orchestration/remoteMatchLifecycle'
import {
  mapPlayersToLocal,
  mapRoundResultToLocal,
  mapWinPresentationToLocal,
  toLocalSeat,
} from './protocol/mapper'
import type { AnimeFixedTtsExecutor, AnimeSeat } from '../llm/animeFixedTtsExecutor'
import { resolveAnimeAudioPolicy, shouldSuppressLegacyAnimeSpeech } from '../core/presentation/animeAudioPolicy'

const WS_BASE = API_BASE.replace(/^http/, 'ws')
const MATCH_NAMES = { east: '东风场', hanchan: '半庄场' }

interface UseRemoteGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  waitForTableReady?: () => Promise<void>
  onLlmMessage?: (seat: number, text: string) => void
  onLlmStatus?: (seat: number, active: boolean, text?: string) => void
  playLlmAudio?: (url: string, seat: number, messageId: number, priority?: 'normal' | 'important') => void
  getCharacterId?: () => string
  getThemeName?: () => string
  animeFixedTts?: AnimeFixedTtsExecutor
}

export function useRemoteGame({
  playSound = () => {},
  playSoundAndWait = async () => {},
  waitForTableReady,
  onLlmMessage = () => {},
  onLlmStatus = () => {},
  playLlmAudio = () => {},
  getCharacterId = () => 'deepseek',
  getThemeName = () => 'jade',
  animeFixedTts,
}: UseRemoteGameOptions = {}) {
  const sessionStore = createRemoteSessionStore()
  const state = createRemoteGameState({
    guestId: sessionStore.loadGuestId() || '',
    storedSession: sessionStore.loadSession(),
  })
  const {
    sessionStatus, sessionError, roomId, mySeat, nickname, rejoinCode, playerId,
    creatorSeat, isCreator, roomSeats, roomTimeLimit, llmEnabled, effectiveLlmEnabled,
    llmAvailable, rulesetId, autoPlay, storedSession,
    phase, players, wallCount, wall, wallHeadDrawn, currentPlayer, selectedIndex,
    turnSeconds, lastDiscard, actionPrompt, announcement, tableActionEvent,
    scoreFlowEvent, result, winEffect, winPresentation, revealHands,
    winningPlayerIndex, round, dealer, honba, matchType, matchFinished,
    dealAnimation, openingStage, diceValues, diceThrowerIndex, userDrewThisTurn, waitingNextRound,
    secondDice, flipTile, jokerTiles, wildcardTiles, flipStack, openingStack, wallBreakIndex,
    turnCanHu, turnCanWindKong,
  } = state
  const presentedWinActions = new Set<string>()
  let fallbackActionSequence = 0
  let fallbackSettlementSequence = 0
  const isWinAction = (type: TableActionEvent['type']) => (
    type === 'self-draw' || type === 'discard-win' || type === 'robbed-kong-win'
  )
  const winActionKey = (winner: number, type: TableActionEvent['type']) => (
    `${roomId.value}:${round.value}:${honba.value}:${winner}:${type}`
  )
  const playAnimeAction = (event: TableActionEvent) => {
    if (!animeFixedTts || getThemeName() !== 'llmAnime') return
    const actor = players[event.actorIndex]
    if (event.actorIndex < 0 || event.actorIndex > 3) return
    if (isWinAction(event.type)) {
      const key = winActionKey(event.actorIndex, event.type)
      if (presentedWinActions.has(key)) return
      presentedWinActions.add(key)
    }
    void animeFixedTts.executeAction({
      eventId: event.id,
      seat: event.actorIndex as AnimeSeat,
      characterId: actor?.characterId,
      action: event.type,
    }).then((execution) => {
      if (execution.fallbackAudioFile) playSound(execution.fallbackAudioFile)
    }).catch(() => {})
  }
  const roomSocket = createRoomSocketTransport({
    getUrl: () => roomId.value && rejoinCode.value
      ? `${WS_BASE}/ws/room/${encodeURIComponent(roomId.value)}?rejoin_code=${encodeURIComponent(rejoinCode.value)}`
      : null,
    onMessage: handleMessage,
  })
  const wsStatus = roomSocket.status
  const signalQuality = roomSocket.signalQuality

  // ── 内部：连接 / 定时器 / 延迟队列 ──
  const timers = new Set<number>()

  const roomLifecycle = createRemoteRoomLifecycle({
    state: {
      sessionStatus, sessionError, roomId, mySeat, nickname, rejoinCode, playerId,
      creatorSeat, isCreator, roomSeats, roomTimeLimit, llmEnabled, effectiveLlmEnabled,
      llmAvailable, rulesetId, storedSession,
      phase, matchType, matchFinished, players,
    },
    sessionStore,
    socket: roomSocket,
    closeConnection,
    resetGame: resetAll,
    getCharacterId,
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
    getThemeName,
    getCharacterIds: () => players.map((player) => player.characterId),
    animeFixedTts,
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
    send: roomSocket.send,
    onFinished: applyBufferedAfterOpening,
    waitForTableReady,
    // 生产 UI 同时提供牌桌 ready 握手时，才启用快照门闸；保留无 UI 测试/工具调用
    // 的旧表现，避免没有牌桌生命周期时开局时间线无人释放。
    waitForOpeningSnapshot: Boolean(waitForTableReady),
  })
  const snapshotReconciler = createSnapshotReconciler({
    state,
    getLocalSeat: () => mySeatLocal.value,
    isShowingRoundResult,
    opening: openingTimeline,
    settlement: settlementTimeline,
    clearCountdown,
    onFinishedSnapshot: () => {
      clearPendingRequest()
      animeFixedTts?.cancel()
    },
    playSound,
    later,
    getThemeName,
  })
  const transientEventPresenter = createTransientEventPresenter({
    state,
    getLocalSeat: () => mySeatLocal.value,
    isOpening: openingTimeline.isRunning,
    showServerAnnouncement: snapshotReconciler.showAnnouncement,
    playSound,
    later,
    getThemeName,
    onFixedAnimeAction: playAnimeAction,
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
    settlement: {
      ...settlementTimeline,
      cancel: () => {
        settlementTimeline.cancel()
        animeFixedTts?.cancel()
      },
    },
    snapshots: snapshotReconciler,
    requests: requestCoordinator,
    transientEvents: transientEventPresenter,
    sendContinue: () => roomSocket.send({
      type: 'continue',
      ...(result.value?.presentationKey ? { presentationKey: result.value.presentationKey } : {}),
    }),
    refreshRoom: roomLifecycle.refreshRoom,
  })
  const { nextRound, returnToLobby } = matchLifecycle

  function clearPendingRequest() {
    requestCoordinator.clearPending()
  }

  function updatePresentationAudioMode() {
    if (!roomId.value || wsStatus.value !== 'connected') return
    roomSocket.send({
      type: 'presentation_audio_mode',
      mode: getThemeName() === 'llmAnime' ? 'anime-fixed-tts-v1' : 'legacy-dynamic',
    })
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
    fallbackSettlementSequence += 1
    timers.forEach((id) => window.clearTimeout(id))
    timers.clear()
    requestCoordinator.clearCountdown()
    openingTimeline.cancel()
    settlementTimeline.cancel()
    animeFixedTts?.cancel()
  }

  function clearCountdown() {
    requestCoordinator.clearCountdown()
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

  function rotatePlayers(snapshotPlayers: ServerPlayerDto[]) {
    return mapPlayersToLocal(snapshotPlayers, mySeatLocal.value)
  }

  // ── 开局动画结束后的统一落地：先应用最新快照，再激活回合/请求 ──

  function applyBufferedAfterOpening() {
    snapshotReconciler.flush()
    requestCoordinator.flush()
  }

  function handleError(code: string) {
    // STALE_ACTION / 超时竞态是正常现象：忽略，由后续快照自愈
    if (code === 'STALE_ACTION' || code === 'INVALID_ACTION') return
    sessionError.value = code
  }

  // ── 消息分发 ───────────────────────────────────────────

  const serverMessageRouter = createServerMessageRouter({
    rejoin_ok: (msg) => {
      fallbackSettlementSequence += 1
      roomId.value = msg.roomId
      mySeat.value = msg.seat
      nickname.value = msg.nickname
      rejoinCode.value = msg.rejoinCode
      matchType.value = msg.mode
      rulesetId.value = msg.rulesetId ?? 'lotus-classic'
      wsStatus.value = 'connected'
      sessionStatus.value = 'connected'
      sessionError.value = ''
      roomSocket.confirmSession()
      updatePresentationAudioMode()
      settlementTimeline.cancel()
      animeFixedTts?.cancel()
      presentedWinActions.clear()
      snapshotReconciler.clearPending()
      snapshotReconciler.resetDiscardDedup()
      requestCoordinator.clearPending()
      matchLifecycle.clearRoundBarrier()
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
    round_start: (msg) => {
      fallbackSettlementSequence += 1
      animeFixedTts?.reset()
      presentedWinActions.clear()
      matchLifecycle.handleRoundStart(msg)
    },
    turn_request: requestCoordinator.apply,
    claim_request: requestCoordinator.apply,
    rob_kong_request: requestCoordinator.apply,
    table_action: transientEventPresenter.handleTableAction,
    score_flow: transientEventPresenter.handleScoreFlow,
    announcement: transientEventPresenter.handleAnnouncement,
    llm_message: (msg) => {
      if (!shouldSuppressLegacyAnimeSpeech(getThemeName(), msg)) onLlmMessage(toLocal(msg.seat), msg.text)
    },
    llm_status: (msg) => onLlmStatus(toLocal(msg.seat), msg.active, msg.text),
    llm_audio: (msg) => {
      if (!shouldSuppressLegacyAnimeSpeech(getThemeName(), msg)) {
        playLlmAudio(`${API_BASE}${msg.audioUrl}`, msg.seat, msg.messageId, msg.priority ?? 'normal')
      }
    },
    hand_result: (msg) => {
      // settled 快照是主路径；这里只兜底断线边缘丢快照的情况。
      if (isShowingRoundResult() || result.value || !players.length || openingTimeline.isRunning()) return
      phase.value = 'revealing'
      const fallbackSettlementId = fallbackSettlementSequence += 1
      revealHands.value = true
      const mapped = mapResult(msg.result)
      // 点炮/抢杠/地胡播 hu，自摸/天胡播 zimo（对齐结算时间线的音效逻辑）。
      const winType = mapped?.winType
      const isDiscardStyle = winType === 'discard' || winType === 'robbed-kong' || winType === 'dihu'
      const winner = mapped?.winnerIndex ?? -1
      const policy = resolveAnimeAudioPolicy({
        themeName: getThemeName(),
        playerKind: players[winner]?.playerKind,
        isLlm: players[winner]?.isLlm,
      })
      if (winner >= 0 && policy.actionVoice === 'fixed-line' && animeFixedTts) {
        const action = winType === 'robbed-kong' ? 'robbed-kong-win'
          : isDiscardStyle ? 'discard-win' : 'self-draw'
        const actionKey = winActionKey(winner, action)
        const alreadyPresented = presentedWinActions.has(actionKey)
        if (!alreadyPresented) {
          const fallbackEvent: TableActionEvent = {
            id: 1_000_000_000 + (fallbackActionSequence += 1),
            type: action,
            actorIndex: winner,
            sourceIndex: null,
            tile: mapped?.winTile ?? winPresentation.value?.tile ?? 'white',
            meldIndex: -1,
          }
          tableActionEvent.value = fallbackEvent
          later(() => {
            if (tableActionEvent.value?.id === fallbackEvent.id) tableActionEvent.value = null
          }, 1050)
          playAnimeAction(fallbackEvent)
        }
      } else if (winner >= 0 && !players[winner]?.isLlm) {
        playSound(isDiscardStyle ? 'hu.mp3' : 'zimo.mp3')
      }
      later(() => {
        const finish = () => {
          if (fallbackSettlementId !== fallbackSettlementSequence) return
          phase.value = 'settled'
          result.value = mapped
        }
        if (policy.resultVoice === 'fixed-line' && animeFixedTts) {
          const draw = Boolean(mapped?.draw)
          const roundWinType = isDiscardStyle
            ? (winType === 'robbed-kong' ? 'robbed-kong' : 'discard')
            : 'self-draw'
          const speech = animeFixedTts.executeRound({
            eventId: mapped?.presentationKey
              ?? `remote-hand-result:${roomId.value}:${round.value}:${honba.value}:${draw ? 'draw' : winner}`,
            characterIds: players.map((player) => player.characterId),
            winnerIndex: draw ? null : winner,
            winType: roundWinType,
            draw,
          })
          void speech.then(finish, finish)
        } else finish()
      }, 600)
    },
    continue_prompt: () => {},
    match_finished: (msg) => {
      fallbackSettlementSequence += 1
      matchLifecycle.finishMatch(msg.finalScores)
    },
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
    fallbackSettlementSequence += 1
    presentedWinActions.clear()
    matchLifecycle.resetAll()
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
    llmEnabled, effectiveLlmEnabled, llmAvailable,
    rulesetId,
    secondDice, flipTile, jokerTiles, wildcardTiles, flipStack, openingStack, wallBreakIndex,
    signalQuality,   // 0-3 信号质量（越大连接越好）
    storedSession,   // 上次未完成对局（「继续对局」入口；null = 无）
    autoPlay, toggleAutoPlay,   // 自动打牌开关（多窗口联机测试/观战）
    remoteActions: roomLifecycle,
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
    })), startGame, selectTile, clearUserSelection, userDiscard, userPass, userPeng,
    userGangFromDiscard, userGang, userChi, userWindKong, userHu,
    nextRound, returnToLobby, tileName, debugPreviewWin,
    updatePresentationAudioMode,
  })
}
