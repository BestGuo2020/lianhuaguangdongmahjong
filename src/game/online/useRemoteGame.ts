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
// 后续快照与请求（pendingSnapshot / pendingRequest），用户点「继续」后再落地。
import { computed, getCurrentInstance, onBeforeUnmount, reactive, ref } from 'vue'
import { API_BASE } from './api/httpClient'
import type { RoomSeatState } from './api/roomApi'
import { defineGamePort } from '../core/gamePort'
import type { Announcement, LastDiscard, RoundResult } from '../core/gamePort'
import type { ActionPrompt } from '../core/playerController'
import { concealedKongs, isWinningHand, matchingCount, waitingTiles } from '../core/rules'
import { TILE_TYPES, tileAudioFile, tileName } from '../core/tiles'
import type { GamePlayer, MatchType, ScoreDelta, ScoreFlowEvent, TableActionEvent, TileType, WinPresentation } from '../core/types'
import type { ServerSnapshot } from './protocol/dto'
import type { RoundStartMessage, ServerMessage, ServerRequest } from './protocol/messages'
import { createRemoteSessionStore, type StoredSession } from './session/remoteSessionStore'
import { createRoomSocketTransport } from './transport/roomSocket'
import { createRemoteRoomLifecycle, type RemoteSessionStatus } from './session/remoteRoomLifecycle'
import { createOpeningTimeline } from './presentation/openingTimeline'
import { createSettlementTimeline } from './presentation/settlementTimeline'
import {
  mapLastDiscardToLocal,
  mapPlayersToLocal,
  mapRoundResultToLocal,
  mapScoreDeltasToLocal,
  mapTableActionToLocal,
  mapWinPresentationToLocal,
  toLocalSeat,
} from './protocol/mapper'

const WS_BASE = API_BASE.replace(/^http/, 'ws')
const MATCH_NAMES = { east: '东风场', hanchan: '半庄场' }

// 自动打牌：开关后到自动出牌/过牌的间隔（毫秒）。留一点时间让摸牌动画/音效可读。
const AUTO_PLAY_DELAY = 600

type ClientPhase =
  | 'lobby' | 'dealing' | 'playing' | 'discard' | 'prompt'
  | 'win-effect' | 'revealing' | 'settled' | 'finished'

interface UseRemoteGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
}

export function useRemoteGame({ playSound = () => {}, playSoundAndWait = async () => {} }: UseRemoteGameOptions = {}) {
  const sessionStore = createRemoteSessionStore()
  // ── 远程会话状态 ──
  const sessionStatus = ref<RemoteSessionStatus>('idle')
  const sessionError = ref('')
  const roomId = ref('')
  const mySeat = ref(-1)                 // 服务端座位（权威）
  const nickname = ref('')
  const rejoinCode = ref('')
  const roomSocket = createRoomSocketTransport({
    getUrl: () => roomId.value && rejoinCode.value
      ? `${WS_BASE}/ws/room/${encodeURIComponent(roomId.value)}?rejoin_code=${encodeURIComponent(rejoinCode.value)}`
      : null,
    onMessage: handleMessage,
  })
  const wsStatus = roomSocket.status
  const signalQuality = roomSocket.signalQuality
  const playerId = ref(sessionStore.loadGuestId() || '')   // 匿名身份（guestId），跨会话稳定
  const creatorSeat = ref<number | null>(null)   // 服务端权威房主座位（轮询刷新，支持房主转移）
  const isCreator = ref(false)
  const roomSeats = ref<Array<RoomSeatState | null>>([])
  const roomTimeLimit = ref<number | null>(null)   // 房间限时（秒），静态提示「超时自动解散」
  // 自动打牌：开关后每步（出牌/碰杠/抢杠提示）到达即自动处理，无需手动点击。
  // 支持 URL 参数 ?auto=1 开启 —— 开 4 个窗口联机测试/观战时可免逐个设置。
  const autoPlay = ref(typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('auto') === '1')
  const storedSession = ref<StoredSession | null>(sessionStore.loadSession())   // 上次未完成对局（继续对局入口）

  // ── 游戏状态（与 useGame 同名同形，App.vue 模板直接复用）──
  const phase = ref<ClientPhase>('lobby')
  const players = reactive<GamePlayer[]>([])
  const wallCount = ref(0)
  const wall = ref<TileType[]>([])
  const wallHeadDrawn = ref(0)   // 服务端权威：牌头已摸走张数（区分牌尾补杠）
  const currentPlayer = ref(-1)
  const selectedIndex = ref(-1)
  const turnSeconds = ref(12)
  const lastDiscard = ref<LastDiscard | null>(null)
  const actionPrompt = ref<ActionPrompt | null>(null)
  const announcement = ref<Announcement | null>(null)
  const tableActionEvent = ref<TableActionEvent | null>(null)
  const scoreFlowEvent = ref<ScoreFlowEvent | null>(null)
  const result = ref<RoundResult | null>(null)
  const winEffect = ref<RoundResult | null>(null)
  const winPresentation = ref<WinPresentation | null>(null)
  const revealHands = ref(false)
  const winningPlayerIndex = ref(-1)
  const round = ref(1)
  const dealer = ref(0)
  const honba = ref(0)
  const matchType = ref<MatchType>('east')
  const matchFinished = ref(false)
  const dealAnimation = ref({ playerIndex: -1, count: 0, serial: 0 })
  const openingStage = ref<string | null>(null)
  const diceValues = ref([1, 1])
  const userDrewThisTurn = ref(false)
  const waitingNextRound = ref(false)   // 已点「继续」，等待其他玩家确认后进下一局

  // ── 内部：连接 / 定时器 / 延迟队列 ──
  let countdownHandle: number | null = null
  let pendingSnapshot: ServerSnapshot | null = null
  let pendingRequest: ServerRequest | null = null
  let lastAnnouncementId = -1   // 服务端公告自增 id：同一公告只展示一次
  let lastDiscardIdApplied = -1   // 出牌报牌：按服务端 lastDiscard.id 去重，重连不重复播
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
    send,
    onFinished: applyBufferedAfterOpening,
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
    window.clearInterval(countdownHandle as number)
    countdownHandle = null
    openingTimeline.cancel()
    settlementTimeline.cancel()
  }

  function clearCountdown() {
    window.clearInterval(countdownHandle as number)
    countdownHandle = null
  }

  function startCountdown(seconds = 12, onExpire: () => void) {
    clearCountdown()
    turnSeconds.value = seconds
    countdownHandle = window.setInterval(() => {
      turnSeconds.value -= 1
      // 倒计时到 3 秒：播一次提示音
      if (turnSeconds.value === 3) playSound('didu.ogg')
      if (turnSeconds.value <= 0) {
        clearCountdown()
        onExpire()
      }
    }, 1000)
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

  function applySnapshotAnnouncement(snap: ServerSnapshot) {
    // 服务端把 announcement 保留为状态，随每份快照重复携带；客户端视为瞬时事件。
    // 按服务端自增 id 去重：同一公告只在首见时展示 1.5s 后自动清除，不随快照反复弹出。
    const serverAnnouncement = snap.announcement
    if (!serverAnnouncement?.text) {
      if (announcement.value) announcement.value = null
      return
    }
    if (serverAnnouncement.id != null) {
      if (serverAnnouncement.id === lastAnnouncementId) return
      lastAnnouncementId = serverAnnouncement.id
    } else if (announcement.value?.text === serverAnnouncement.text) {
      return
    }
    announcement.value = {
      text: serverAnnouncement.text,
      tone: serverAnnouncement.tone ?? 'gold',
      id: serverAnnouncement.id ?? Date.now(),
    }
    later(() => {
      if (announcement.value?.text === serverAnnouncement.text) announcement.value = null
    }, 1500)
  }

  function applyLastDiscard(snap: ServerSnapshot) {
    // 快照是唯一真源：更新最近弃牌；新弃牌（id 变化）播「打牌 + 牌名报牌」音效，
    // 同 id 重放（重连 / 冗余快照）不重复播。
    const ld = snap.lastDiscard
    if (!ld) {
      lastDiscard.value = null
      return
    }
    lastDiscard.value = mapLastDiscardToLocal(ld, mySeatLocal.value)
    if (ld.id === lastDiscardIdApplied) return
    lastDiscardIdApplied = ld.id
    // 开局动画期间（对局开始/骰子音效播放中）不报牌：首家弃牌与开场音效重叠会刺耳
    if (openingTimeline.isRunning()) return
    playSound('dapai.mp3', 0.8)
    const audio = tileAudioFile(ld.tile)
    if (audio) later(() => playSound(audio), 80)
  }

  function mapAndApply(snap: ServerSnapshot) {
    if (snap.matchFinished || snap.phase === 'finished') {
      settlementTimeline.cancel()
      pendingSnapshot = null
      pendingRequest = null
      matchFinished.value = true
      phase.value = 'finished'
      result.value = null
      winEffect.value = null
      winPresentation.value = null
      revealHands.value = true
      winningPlayerIndex.value = -1
      players.splice(0, players.length, ...rotatePlayers(snap.players))
      wall.value = snap.wall ?? []
      wallHeadDrawn.value = snap.headDrawn ?? 0
      return
    }
    if (snap.phase === 'settled' && snap.result) {
      // 结算快照：触发赢牌动画 / 结算展示
      players.splice(0, players.length, ...rotatePlayers(snap.players))
      wall.value = snap.wall ?? []
      wallHeadDrawn.value = snap.headDrawn ?? 0
      wallCount.value = snap.wallCount
      currentPlayer.value = snap.currentPlayer >= 0 ? toLocal(snap.currentPlayer) : -1
      dealer.value = toLocal(snap.dealer)
      honba.value = snap.honba
      round.value = snap.round
      applyLastDiscard(snap)
      applySnapshotAnnouncement(snap)
      settlementTimeline.start(snap)
      return
    }
    // 普通进行中快照
    selectedIndex.value = -1
    players.splice(0, players.length, ...rotatePlayers(snap.players))
    wall.value = snap.wall ?? []
    wallHeadDrawn.value = snap.headDrawn ?? 0
    wallCount.value = snap.wallCount
    currentPlayer.value = snap.currentPlayer >= 0 ? toLocal(snap.currentPlayer) : -1
    dealer.value = toLocal(snap.dealer)
    honba.value = snap.honba
    round.value = snap.round
    applyLastDiscard(snap)
    applySnapshotAnnouncement(snap)
    winningPlayerIndex.value = snap.winningPlayerIndex >= 0 ? toLocal(snap.winningPlayerIndex) : -1
    result.value = null
    actionPrompt.value = null
    clearCountdown()
    // 预开局（WS 握手即广播一份 phase='lobby' 的快照）保持 lobby 面板，
    // 只有真正的对局快照才进入 playing，否则房间面板会被顶掉无法准备/开局。
    phase.value = snap.phase === 'lobby' ? 'lobby' : 'playing'
  }

  function applySnapshot(snap: ServerSnapshot) {
    if (isShowingRoundResult()) {
      pendingSnapshot = snap
      return
    }
    if (openingTimeline.isRunning()) {
      // 开局动画期间（对局开始/骰子/发牌）不填表：发牌动画结束后统一落地。
      // 首份快照作为发牌动画数据源（各家手牌数/值），后续只保留最新待落地。
      openingTimeline.captureSnapshot(snap)
      pendingSnapshot = snap
      return
    }
    mapAndApply(snap)
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
    if (pendingSnapshot) {
      const snap = pendingSnapshot
      pendingSnapshot = null
      mapAndApply(snap)
    }
    if (pendingRequest) {
      const req = pendingRequest
      pendingRequest = null
      applyRequest(req)
    }
  }

  // ── 请求应用（回合 / 碰杠 / 抢杠提示）─────────────────

  function applyRequest(msg: ServerRequest) {
    if (isShowingRoundResult() || openingTimeline.isRunning()) {
      pendingRequest = msg
      return
    }
    if (msg.kind === 'turn_request') {
      currentPlayer.value = 0
      userDrewThisTurn.value = !msg.ctx.skipDraw
      actionPrompt.value = null
      phase.value = 'discard'
      if (!msg.ctx.skipDraw) playSound('give.mp3', 0.7)
      startCountdown(12, () => {
        if (!isUserTurn.value || !user.value?.hand.length) return
        userDiscard(user.value.hand.length - 1)
      })
      // 自动打牌：可胡则胡，否则自动打出进张最多的牌（留一点动画/音效时间）
      if (autoPlay.value) {
        later(() => {
          if (!autoPlay.value || !isUserTurn.value) return
          if (userCanHu.value) userHu()
          else userDiscard(autoPickDiscard())
        }, AUTO_PLAY_DELAY)
      }
      return
    }
    if (msg.kind === 'claim_request') {
      actionPrompt.value = {
        type: 'claim',
        tile: msg.ctx.tile,
        from: toLocal(msg.ctx.from),
        canGang: msg.ctx.canGang,
      }
      phase.value = 'prompt'
      startCountdown(12, () => {
        if (actionPrompt.value?.type === 'claim') userPass()
      })
      if (autoPlay.value) {
        later(() => {
          if (!autoPlay.value || actionPrompt.value?.type !== 'claim') return
          userPass()
        }, AUTO_PLAY_DELAY)
      }
      return
    }
    // rob_kong_request
    actionPrompt.value = { type: 'rob', tile: msg.ctx.tile, from: toLocal(msg.ctx.from) }
    phase.value = 'prompt'
    announce('可抢杠胡', 'red')
    startCountdown(12, () => {
      if (actionPrompt.value?.type === 'rob') userPass()
    })
    if (autoPlay.value) {
      later(() => {
        if (!autoPlay.value || actionPrompt.value?.type !== 'rob') return
        userPass()
      }, AUTO_PLAY_DELAY)
    }
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
    // 结算展示期间到达的公告（如下一局「开牌」）不弹出：避免盖住赢牌动画/结算窗。
    // 开局动画期间也不弹：随发牌后落地的快照自然展示一次（快照同样携带该公告，由 id 去重兜底）。
    if (isShowingRoundResult() || openingTimeline.isRunning()) return
    if (msg.id != null) {
      if (msg.id === lastAnnouncementId) return
      lastAnnouncementId = msg.id
    }
    announcement.value = { text: msg.text, tone: msg.tone, id: msg.id ?? Date.now() }
    later(() => {
      if (announcement.value?.text === msg.text) announcement.value = null
    }, 1500)
  }

  function handleMatchFinished(msg: { kind: 'match_finished'; finalScores: Array<{ seat: number; name: string; score: number }> }) {
    settlementTimeline.cancel()
    pendingSnapshot = null
    pendingRequest = null
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

  function handleMessage(raw: unknown) {
    const msg = raw as ServerMessage
    switch (msg.kind) {
      case 'rejoin_ok':
        roomId.value = msg.roomId
        mySeat.value = msg.seat
        nickname.value = msg.nickname
        rejoinCode.value = msg.rejoinCode
        matchType.value = msg.mode
        wsStatus.value = 'connected'
        sessionStatus.value = 'connected'
        sessionError.value = ''
        roomSocket.confirmSession()
        // 重连时清掉旧结算展示，避免误延迟新状态
        settlementTimeline.cancel()
        pendingSnapshot = null
        pendingRequest = null
        lastDiscardIdApplied = -1   // 允许重连后当前弃牌播一次报牌音效
        pendingRoundStart = null
        openingTimeline.cancel()
        waitingNextRound.value = false
        result.value = null
        winEffect.value = null
        winPresentation.value = null
        revealHands.value = false
        matchFinished.value = false
        break
      case 'rejoin_err':
        wsStatus.value = 'closed'
        sessionError.value = msg.code
        // 重进码被服务端拒绝（房间没了 / 被封禁 / 码失效）：持久化会话作废
        roomLifecycle.clearSession()
        break
      case 'state_snapshot':
        applySnapshot(msg)
        break
      case 'round_start':
        handleRoundStart(msg)
        break
      case 'turn_request':
      case 'claim_request':
      case 'rob_kong_request':
        applyRequest(msg)
        break
      case 'table_action':
        handleTableAction(msg)
        break
      case 'score_flow':
        handleScoreFlow(msg)
        break
      case 'announcement':
        handleAnnouncement(msg)
        break
      case 'hand_result':
        // 冗余消息：settled 快照已触发结算展示；断线边缘快照丢失时兜底。
        // 开局动画期间（如四红中立即和牌）忽略，等发牌后缓冲的 settled 快照统一展示。
        if (!isShowingRoundResult() && !result.value && players.length && !openingTimeline.isRunning()) {
          phase.value = 'revealing'
          revealHands.value = true
          const mapped = mapResult(msg.result)
          // 兜底分支同样播胡牌音效（与结算表现时间线主路径对齐）
          playSound('zimo.mp3')
          later(() => {
            phase.value = 'settled'
            result.value = mapped
          }, 600)
        }
        break
      case 'match_finished':
        handleMatchFinished(msg)
        break
      case 'room_closed':
        // 房间被创建者解散：清理本地会话回大厅
        void roomLifecycle.leaveRoom()
        break
      case 'pong':
        // 心跳和信号质量由 transport/roomSocket 统一处理。
        break
      case 'error':
        handleError(msg.code)
        break
      default:
        break
    }
  }

  function closeConnection() {
    roomSocket.close()
    clearTimers()
  }

  // ── 重置 ───────────────────────────────────────────────

  function resetAll() {
    clearTimers()
    pendingSnapshot = null
    pendingRequest = null
    lastAnnouncementId = -1   // 新会话公告 id 从 1 重新计数
    lastDiscardIdApplied = -1
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

  // ── 用户动作（发送到服务端，状态由快照权威回写）────────

  function send(message: Record<string, unknown>) {
    roomSocket.send(message)
  }

  function selectTile(index: number) {
    if (!isUserTurn.value) return
    selectedIndex.value = index
    playSound('click.mp3', 0.65)
  }

  function clearUserSelection() {
    selectedIndex.value = -1
  }

  function userDiscard(index = selectedIndex.value) {
    if (!isUserTurn.value || index < 0 || index >= user.value.hand.length) return
    clearCountdown()
    selectedIndex.value = -1
    send({ type: 'discard', handIndex: index })
  }

  // 自动打牌挑张：弃牌后听牌（可进张牌种）数最多者；无进张时退回末张。
  function autoPickDiscard(): number {
    const hand = user.value?.hand ?? []
    if (!hand.length) return -1
    const meldCount = structuralMeldCount(user.value)
    let bestIndex = hand.length - 1
    let bestWaits = -1
    const seen = new Set()
    for (let i = 0; i < hand.length; i += 1) {
      const tile = hand[i]
      if (seen.has(tile)) continue
      seen.add(tile)
      const after = hand.filter((_, j) => j !== i)
      const waits = waitingTiles(after, meldCount).length
      if (waits > bestWaits) {
        bestWaits = waits
        bestIndex = i
      }
    }
    return bestIndex
  }

  function toggleAutoPlay() {
    autoPlay.value = !autoPlay.value
  }

  function userPass() {
    const prompt = actionPrompt.value
    clearCountdown()
    actionPrompt.value = null
    if (!prompt) return
    playSound('click.mp3', 0.65)
    send({ type: 'pass' })
  }

  function userPeng() {
    if (actionPrompt.value?.type !== 'claim') return
    clearCountdown()
    actionPrompt.value = null
    playSound('click.mp3', 0.65)
    send({ type: 'claim', action: 'peng' })
  }

  function userGangFromDiscard() {
    if (actionPrompt.value?.type !== 'claim' || !actionPrompt.value.canGang) return
    clearCountdown()
    actionPrompt.value = null
    playSound('click.mp3', 0.65)
    send({ type: 'claim', action: 'gang' })
  }

  function userGang(tile = userKongs.value[0]) {
    if (!tile || !isUserTurn.value) return
    clearCountdown()
    playSound('click.mp3', 0.65)
    const hasPengMeld = user.value.melds.some((meld) => meld.type === 'peng' && meld.tile === tile)
    send({ type: 'gang', kind: hasPengMeld ? 'added' : 'concealed', tile })
  }

  function userHu() {
    if (actionPrompt.value?.type === 'rob') {
      clearCountdown()
      actionPrompt.value = null
      playSound('click.mp3', 0.65)
      send({ type: 'hu' })
      return
    }
    if (userCanHu.value) {
      clearCountdown()
      send({ type: 'hu' })
    }
  }

  // ── 场次推进（远程：服务端无条件推进，客户端只清除结算展示）──

  function nextRound() {
    settlementTimeline.cancel()
    if (matchFinished.value) return
    // 确认屏障：通知服务端本家已看完结算。**不清结算态**——对话框保留、
    // 按钮显示「等待其他玩家确定...」；等服务端等齐所有在线真人后推进，
    // round_start 到达时由 handleRoundStart → startOpeningRound 统一清理结算态。
    send({ type: 'continue' })
    waitingNextRound.value = true
    if (pendingRoundStart) {
      // 服务端兜底已推进，round_start 在结算展示期间已缓冲 → 直接落地
      const rs = pendingRoundStart
      pendingRoundStart = null
      waitingNextRound.value = false
      startOpeningRound(rs)
    }
    if (pendingSnapshot) {
      const snap = pendingSnapshot
      pendingSnapshot = null
      // 若仍处结算态会再次缓冲，随下一局发牌动画结束后统一落地；滞留的旧结算快照丢弃
      if (!(snap.phase === 'settled' && snap.result)) applySnapshot(snap)
    }
    if (pendingRequest) {
      const req = pendingRequest
      pendingRequest = null
      applyRequest(req)   // applyRequest 内部会按开局表现时间线的运行状态重新缓冲
    }
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
