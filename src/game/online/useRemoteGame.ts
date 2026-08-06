// 远程对局 composable —— 与 useGame 返回完全兼容的接口，但状态由服务端快照驱动
//
// 职责划分：
// - REST（remoteApi.ts）管理房间生命周期：创建 / 加入 / 准备 / 开始 / 离开
// - WebSocket 只做实时对局：state_snapshot 为唯一真源，turn/claim/rob 请求驱动交互
//
// 座位旋转：服务端座位是权威索引，客户端固定把「本家」排到 players[0]（桌面底部）。
// 所有座位敏感字段（currentPlayer / dealer / lastDiscard / tableAction / scoreFlow /
// result / winPresentation）在应用时统一经 toLocal() 映射。
//
// 结算展示：服务端无条件推进场次，客户端在赢牌动画 / 结算弹窗期间延迟应用
// 后续快照与请求（pendingSnapshot / pendingRequest），用户点「继续」后再落地。
import { computed, getCurrentInstance, onBeforeUnmount, reactive, ref } from 'vue'
import { API_BASE, closeRoom, createRoom, getRoom, joinRoom, leaveRoom, readyRoom, startRoom } from './remoteApi'
import type { RoomSeatState } from './remoteApi'
import type { ActionPrompt } from '../core/playerController'
import { concealedKongs, isWinningHand, matchingCount, waitingTiles } from '../core/rules'
import { TILE_TYPES, tileAudioFile, tileName } from '../core/tiles'
import type { GamePlayer, MatchType, Meld, ScoreDelta, ScoreFlowEvent, TableActionEvent, TileType, WinPresentation } from '../core/types'
import {
  prefersReducedMotion,
  REDUCED_WIN_EFFECT_DURATION,
  REDUCED_WIN_REVEAL_DURATION,
  WIN_EFFECT_DURATION,
  WIN_EFFECT_SOUND_DELAY,
  WIN_REVEAL_DURATION,
} from '../core/winEffect'

const AVATAR_BASE = `${import.meta.env.BASE_URL}avatars/`
const DEFAULT_AVATARS = ['lotus', 'ah-lok', 'shisan', 'young-master'].map((name) => `${AVATAR_BASE}${name}.svg`)
const WS_BASE = API_BASE.replace(/^http/, 'ws')
const MATCH_NAMES = { east: '东风场', hanchan: '半庄场' }

// ─── 匿名身份与会话持久化（Phase 8 P1）：guestId / 昵称 / 对局会话 ──
// 刷新 / 关浏览器后凭 localStorage 里的会话一键「继续对局」，对局中座位（AI 托管）可找回。
const STORAGE = {
  guestId: 'lgm_guest_id',
  nickname: 'lgm_nickname',
  session: 'lgm_session',
}

interface StoredSession {
  roomId: string
  rejoinCode: string
  nickname: string
  playerId: string
  mode: MatchType
}

function loadStored(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null
  } catch {
    return null   // 隐私模式 / 无 localStorage 环境
  }
}

function saveStored(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value)
  } catch {
    // 隐私模式静默
  }
}

function clearStored(key: string): void {
  try {
    window.localStorage?.removeItem(key)
  } catch {
    // 忽略
  }
}

function generateGuestId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  const stamp = Date.now().toString(36).slice(-4)
  return `g${rand}${stamp}`
}

type RoundResult = Record<string, any>
interface Announcement { text: string; tone: string; id: number }
interface LastDiscard { tile: TileType; from: number; id: number }

type ClientPhase =
  | 'lobby' | 'dealing' | 'playing' | 'discard' | 'prompt'
  | 'win-effect' | 'revealing' | 'settled' | 'finished'

// ─── 服务端消息类型（对应 backend messages.py）────────────

interface ServerSnapshot {
  kind: 'state_snapshot'
  roomId: string
  mode: MatchType
  phase: string
  round: number
  dealer: number
  honba: number
  dice?: [number, number]
  wallCount: number
  currentPlayer: number
  players: GamePlayer[]
  seat: number
  result: RoundResult | null
  announcement: Announcement | null
  matchFinished: boolean
  lastDiscard: LastDiscard | null
  winPresentation: WinPresentation | null
  winningPlayerIndex: number
}

interface RoundStartMessage {
  kind: 'round_start'
  matchStarted: boolean
  round: number
  dealer: number
  honba: number
  dice: [number, number]
}

type ServerRequest =
  | { kind: 'turn_request'; ctx: { hand: TileType[]; melds: Meld[]; exposedMelds: number; kongBloom: boolean; skipDraw: boolean; afterKong: boolean } }
  | { kind: 'claim_request'; ctx: { hand: TileType[]; canGang: boolean; tile: TileType; from: number } }
  | { kind: 'rob_kong_request'; ctx: { tile: TileType; from: number; hand: TileType[]; exposedMelds: number } }

type ServerMessage =
  | ServerSnapshot
  | ServerRequest
  | RoundStartMessage
  | { kind: 'rejoin_ok'; seat: number; rejoin: boolean; roomId: string; mode: MatchType; nickname: string; rejoinCode: string }
  | { kind: 'rejoin_err'; code: string }
  | { kind: 'table_action'; event: TableActionEvent }
  | { kind: 'score_flow'; deltas: ScoreDelta[] }
  | { kind: 'announcement'; text: string; tone: string; id?: number }
  | { kind: 'hand_result'; result: RoundResult }
  | { kind: 'continue_prompt'; total: number }
  | { kind: 'match_finished'; roomId: string; mode: MatchType; finalScores: Array<{ seat: number; name: string; score: number }> }
  | { kind: 'room_closed' }
  | { kind: 'pong' }
  | { kind: 'error'; code: string }

interface UseRemoteGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
}

function defaultAvatarForSeat(serverSeat: number): string {
  return DEFAULT_AVATARS[((serverSeat % 4) + 4) % 4]
}

export function useRemoteGame({ playSound = () => {}, playSoundAndWait = async () => {} }: UseRemoteGameOptions = {}) {
  // ── 远程会话状态 ──
  const sessionStatus = ref<'idle' | 'creating' | 'joining' | 'connected' | 'readying' | 'playing'>('idle')
  const wsStatus = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'>('idle')
  const sessionError = ref('')
  const signalQuality = ref(0)   // 0-3 信号质量（越大连接越好，由 ping/pong RTT 测得）
  const roomId = ref('')
  const mySeat = ref(-1)                 // 服务端座位（权威）
  const nickname = ref('')
  const rejoinCode = ref('')
  const playerId = ref(loadStored(STORAGE.guestId) || '')   // 匿名身份（guestId），跨会话稳定
  const creatorSeat = ref<number | null>(null)   // 服务端权威房主座位（轮询刷新，支持房主转移）
  const isCreator = ref(false)
  const roomSeats = ref<Array<RoomSeatState | null>>([])
  const storedSession = ref<StoredSession | null>(readStoredSession())   // 上次未完成对局（继续对局入口）
  ensurePlayerId()   // 启动即生成匿名身份：战绩按 guestId 查，无需先输入昵称/进房

  // ── 游戏状态（与 useGame 同名同形，App.vue 模板直接复用）──
  const phase = ref<ClientPhase>('lobby')
  const players = reactive<GamePlayer[]>([])
  const wallCount = ref(0)
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
  let ws: WebSocket | null = null
  let closedByUser = false
  let reconnectTimer: number | null = null
  let reconnectAttempts = 0
  let pollTimer: number | null = null
  let pingTimer: number | null = null
  let lastPingAt = 0   // 最近一次 ping 的发送时刻（测 RTT → 信号质量）
  let countdownHandle: number | null = null
  let winSequenceTimer: number | null = null
  let winSequenceSerial = 0
  let pendingSnapshot: ServerSnapshot | null = null
  let pendingRequest: ServerRequest | null = null
  let lastAnnouncementId = -1   // 服务端公告自增 id：同一公告只展示一次
  let lastDiscardIdApplied = -1   // 出牌报牌：按服务端 lastDiscard.id 去重，重连不重复播
  let pendingRoundStart: RoundStartMessage | null = null
  let openingInProgress = false   // 开局动画期间缓冲回合/请求提示
  let openingSequence = 0
  let openingSnapshot: ServerSnapshot | null = null   // 开局期间缓冲的首份快照（发牌动画数据源）
  const timers = new Set<number>()

  // ── 座位映射（服务端座位 → 本地索引）────────────────────
  const mySeatLocal = computed(() => (mySeat.value >= 0 ? mySeat.value : -1))
  const toLocal = (serverSeat: number) => ((serverSeat - mySeatLocal.value + 4) % 4 + 4) % 4

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

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => later(resolve, ms))
  }

  function clearTimers() {
    openingSequence += 1
    timers.forEach((id) => window.clearTimeout(id))
    timers.clear()
    window.clearInterval(countdownHandle as number)
    countdownHandle = null
    window.clearTimeout(winSequenceTimer as number)
    winSequenceTimer = null
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

  function cancelWinSequence() {
    winSequenceSerial += 1
    window.clearTimeout(winSequenceTimer as number)
    winSequenceTimer = null
  }

  function mapResult(raw: RoundResult | null): RoundResult | null {
    if (!raw) return null
    return {
      ...raw,
      winnerIndex: raw.winnerIndex != null && raw.winnerIndex >= 0 ? toLocal(raw.winnerIndex) : -1,
      robbedKongPlayerIndex: raw.robbedKongPlayerIndex != null && raw.robbedKongPlayerIndex >= 0
        ? toLocal(raw.robbedKongPlayerIndex)
        : -1,
      // 流局听牌名单：服务端座位 → 本地索引（结算页按 scoreChanges 展示）
      tenpai: (raw.tenpai ?? []).map((seat: number) => toLocal(seat)),
      scoreChanges: (raw.scoreChanges ?? []).map((change: any) => ({
        ...change,
        // avatar 先按服务端座位补默认，再映射 playerIndex
        avatar: change.avatar || defaultAvatarForSeat(change.playerIndex),
        playerIndex: toLocal(change.playerIndex),
      })),
    }
  }

  function mapWinPresentation(wp: WinPresentation | null): WinPresentation | null {
    if (!wp) return null
    return {
      ...wp,
      winnerIndex: toLocal(wp.winnerIndex),
      robbedKongPlayerIndex: wp.robbedKongPlayerIndex >= 0 ? toLocal(wp.robbedKongPlayerIndex) : -1,
    }
  }

  function startWinSequence(snap: ServerSnapshot) {
    cancelWinSequence()
    const serial = winSequenceSerial
    const mapped = mapResult(snap.result)
    const wp = mapWinPresentation(snap.winPresentation)
    winningPlayerIndex.value = snap.winningPlayerIndex >= 0
      ? toLocal(snap.winningPlayerIndex)
      : (mapped?.winnerIndex ?? -1)
    const isDraw = Boolean(snap.result?.draw) || !wp

    if (isDraw) {
      // 流局：简短翻牌后直接展示结算
      phase.value = 'revealing'
      revealHands.value = true
      winPresentation.value = null
      winEffect.value = null
      winSequenceTimer = window.setTimeout(() => {
        if (winSequenceSerial !== serial) return
        phase.value = 'settled'
        result.value = mapped
      }, 600)
      return
    }

    const reducedMotion = prefersReducedMotion()
    const effectDuration = reducedMotion ? REDUCED_WIN_EFFECT_DURATION : WIN_EFFECT_DURATION
    const revealDuration = reducedMotion ? REDUCED_WIN_REVEAL_DURATION : WIN_REVEAL_DURATION
    phase.value = 'win-effect'
    revealHands.value = false
    winPresentation.value = wp
    winEffect.value = {
      winnerIndex: winningPlayerIndex.value,
      tile: wp.tile,
      robbedKong: wp.robbedKong,
      robbedKongPlayerIndex: wp.robbedKongPlayerIndex,
      robbedKongMeldIndex: wp.robbedKongMeldIndex,
      duration: effectDuration,
      reducedMotion,
      id: Date.now(),
    }
    playSound(wp.robbedKong ? 'hu.mp3' : 'zimo.mp3')
    // 胡牌特效音（延迟播出），与本地 useGame.endGame 对齐；reducedMotion 时跳过
    if (!reducedMotion) {
      later(() => {
        if (winSequenceSerial === serial) playSound('hu_effect_sound.mp3', 0.72)
      }, WIN_EFFECT_SOUND_DELAY)
    }
    winSequenceTimer = window.setTimeout(() => {
      if (winSequenceSerial !== serial) return
      phase.value = 'revealing'
      // 亮牌前先清掉 winEffect：否则 revealHands 翻转触发 3D rebuild 时，
      // addWinEffect 会用新的 startedAt 重播整段胡牌特效（本地 endGame 同样先置 null）。
      winEffect.value = null
      revealHands.value = true
      winSequenceTimer = window.setTimeout(() => {
        if (winSequenceSerial !== serial) return
        phase.value = 'settled'
        result.value = mapped
      }, revealDuration)
    }, effectDuration)
  }

  // ── 快照应用 ───────────────────────────────────────────

  function rotatePlayers(snapshotPlayers: GamePlayer[]): GamePlayer[] {
    return [...snapshotPlayers]
      .sort((a, b) => toLocal(a.seat) - toLocal(b.seat))
      .map((player) => ({
        ...player,
        // seat 保留服务端权威座位（仅作稳定 key），本地位置由数组索引决定
        avatar: player.avatar || defaultAvatarForSeat(player.seat),
        // 副露来源 from 是服务端座位，须映射为本地索引供 3D 计算指向
        // （meldSourceTileIndex 用 (from - playerIndex + 4) % 4）。
        // 否则只有房主（服务端座位 0 == 本地 0）能对上，其它玩家指向错误。
        melds: player.melds.map((meld) => (
          meld.from != null ? { ...meld, from: toLocal(meld.from) } : meld
        )),
      }))
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
    lastDiscard.value = { ...ld, from: toLocal(ld.from) }
    if (ld.id === lastDiscardIdApplied) return
    lastDiscardIdApplied = ld.id
    // 开局动画期间（对局开始/骰子音效播放中）不报牌：首家弃牌与开场音效重叠会刺耳
    if (openingInProgress) return
    playSound('dapai.mp3', 0.8)
    const audio = tileAudioFile(ld.tile)
    if (audio) later(() => playSound(audio), 80)
  }

  function mapAndApply(snap: ServerSnapshot) {
    if (snap.matchFinished || snap.phase === 'finished') {
      cancelWinSequence()
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
      return
    }
    if (snap.phase === 'settled' && snap.result) {
      // 结算快照：触发赢牌动画 / 结算展示
      players.splice(0, players.length, ...rotatePlayers(snap.players))
      wallCount.value = snap.wallCount
      currentPlayer.value = snap.currentPlayer >= 0 ? toLocal(snap.currentPlayer) : -1
      dealer.value = toLocal(snap.dealer)
      honba.value = snap.honba
      round.value = snap.round
      applyLastDiscard(snap)
      applySnapshotAnnouncement(snap)
      startWinSequence(snap)
      return
    }
    // 普通进行中快照
    selectedIndex.value = -1
    players.splice(0, players.length, ...rotatePlayers(snap.players))
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
    if (openingInProgress) {
      // 开局动画期间（对局开始/骰子/发牌）不填表：发牌动画结束后统一落地。
      // 首份快照作为发牌动画数据源（各家手牌数/值），后续只保留最新待落地。
      if (!openingSnapshot) {
        openingSnapshot = snap
        // 开局显示满墙（snap.wallCount 是发牌后的余数，+52 = 每家 13 张已发的满墙值），
        // 发牌动画逐步递减到真实值，对齐本地 startGame 的「满墙 → 递减」观感。
        wallCount.value = snap.wallCount + 52
        // 先摆空桌：站位/名字/分数可见，手牌由发牌动画逐步填充
        const skeleton = rotatePlayers(snap.players)
        players.splice(0, players.length, ...skeleton.map((p) => ({
          ...p, hand: [], discards: [], melds: [], drawnTileIndex: -1,
        })))
      }
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
    startOpeningRound(msg)
  }

  function startOpeningRound(msg: RoundStartMessage) {
    round.value = msg.round
    dealer.value = toLocal(msg.dealer)   // 服务端座位 → 本地索引
    honba.value = msg.honba
    diceValues.value = msg.dice
    openingSnapshot = null
    // 清空上一局牌桌：三家手牌由发牌动画逐步重建（本家空手等待发牌）
    players.forEach((p) => {
      p.hand.splice(0)
      p.discards.splice(0)
      p.melds.splice(0)
      p.drawnTileIndex = -1
    })
    currentPlayer.value = -1
    selectedIndex.value = -1
    actionPrompt.value = null
    lastDiscard.value = null
    result.value = null
    winEffect.value = null
    winPresentation.value = null
    revealHands.value = false
    winningPlayerIndex.value = -1
    phase.value = 'dealing'
    void runOpeningSequence()
  }

  async function runOpeningSequence() {
    const sequence = openingSequence
    openingInProgress = true
    // 每局都展示「xx场·xx局 · 对局开始」提示，对齐本地 startGame（matchStarted 仅决定音效/文案强弱）
    openingStage.value = 'start'
    await Promise.all([playSoundAndWait('game_start.mp3'), wait(1250)])
    if (sequence !== openingSequence) { openingStage.value = null; openingInProgress = false; return }
    openingStage.value = 'dice'
    await Promise.all([playSoundAndWait('dice.mp3'), wait(1150)])
    if (sequence !== openingSequence) { openingStage.value = null; openingInProgress = false; return }
    if (openingSnapshot) {
      const dealt = await runDealSequence(sequence)
      if (!dealt) return
    }
    openingStage.value = null
    openingInProgress = false
    applyBufferedAfterOpening()
    // 开局就绪屏障：发牌动画结束、本家已就绪 → 通知服务端，等所有在线真人就绪才开局，
    // 避免服务端在慢设备上抢跑（AI 已出牌/副露/胡牌而用户没反应过来）。
    send({ type: 'opening_done' })
  }

  // ── 发牌动画：按庄家顺序逐批从缓冲快照取牌，驱动 3D 发牌 tween ──

  async function runDealSequence(sequence: number): Promise<boolean> {
    const snap = openingSnapshot
    if (!snap) return true
    openingStage.value = 'deal'
    phase.value = 'dealing'
    const source = rotatePlayers(snap.players)          // 本地顺序
    const hands = source.map((p) => [...p.hand])        // 本家真实，他家为 null（仅牌数）
    players.splice(0, players.length, ...source.map((p) => ({
      ...p, hand: [], discards: [], melds: [], drawnTileIndex: -1,
    })))
    const localDealer = dealer.value                    // 已映射为本地索引
    const seatOrder = Array.from({ length: players.length }, (_, i) => (localDealer + i) % players.length)
    let serial = 0
    const dealBatch = async (playerIndex: number, count: number): Promise<boolean> => {
      if (sequence !== openingSequence) return false
      const remaining = hands[playerIndex].length
      const slice = hands[playerIndex].splice(remaining - count, count)
      players[playerIndex].hand.push(...slice)
      // 发牌即耗牌墙：中央剩余牌数随发牌实时递减（对齐本地 startGame 的观感）
      wallCount.value = Math.max(0, wallCount.value - count)
      dealAnimation.value = { playerIndex, count, serial: serial + 1 }
      serial += 1
      playSound('deal.mp3', 0.72)
      await wait(count === 4 ? 260 : 150)
      return true
    }
    for (let batch = 0; batch < 3; batch += 1) {
      for (const playerIndex of seatOrder) {
        if (!(await dealBatch(playerIndex, 4))) return false
      }
    }
    for (const playerIndex of seatOrder) {
      if (!(await dealBatch(playerIndex, 1))) return false
    }
    dealAnimation.value = { playerIndex: -1, count: 0, serial: serial + 1 }
    return true
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
    if (isShowingRoundResult() || openingInProgress) {
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
      return
    }
    // rob_kong_request
    actionPrompt.value = { type: 'rob', tile: msg.ctx.tile, from: toLocal(msg.ctx.from) }
    phase.value = 'prompt'
    announce('可抢杠胡', 'red')
    startCountdown(12, () => {
      if (actionPrompt.value?.type === 'rob') userPass()
    })
  }

  // ── 瞬时事件（动画 / 播报 / 分数流水）─────────────────

  function handleTableAction(msg: { kind: 'table_action'; event: TableActionEvent }) {
    // 赢牌动作（self-draw / robbed-kong-win）：展示「自摸 / 抢杠胡」文字提示，
    // 但**不播音效**（zimo/hu 由 settled 快照的 startWinSequence 统一播放，避免双响）。
    // 开局动画期间（如四红中立即和牌）→ 等发牌结束的 settled 快照统一展示。
    const isWin = msg.event.type === 'self-draw' || msg.event.type === 'robbed-kong-win'
    if (openingInProgress) return
    const event: TableActionEvent = {
      ...msg.event,
      actorIndex: toLocal(msg.event.actorIndex),
      sourceIndex: msg.event.sourceIndex != null ? toLocal(msg.event.sourceIndex) : null,
    }
    tableActionEvent.value = event
    later(() => {
      if (tableActionEvent.value?.id === event.id) tableActionEvent.value = null
    }, 1050)
    if (isWin) return   // 赢牌音效统一由 startWinSequence 播放
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
      deltas: msg.deltas.map((delta) => ({ ...delta, playerIndex: toLocal(delta.playerIndex) })),
    }
    scoreFlowEvent.value = event
    later(() => {
      if (scoreFlowEvent.value?.id === event.id) scoreFlowEvent.value = null
    }, 1050)
  }

  function handleAnnouncement(msg: { kind: 'announcement'; text: string; tone: string; id?: number }) {
    // 结算展示期间到达的公告（如下一局「开牌」）不弹出：避免盖住赢牌动画/结算窗。
    // 开局动画期间也不弹：随发牌后落地的快照自然展示一次（快照同样携带该公告，由 id 去重兜底）。
    if (isShowingRoundResult() || openingInProgress) return
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
    cancelWinSequence()
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
        reconnectAttempts = 0
        // 重连时清掉旧结算展示，避免误延迟新状态
        cancelWinSequence()
        pendingSnapshot = null
        pendingRequest = null
        lastDiscardIdApplied = -1   // 允许重连后当前弃牌播一次报牌音效
        pendingRoundStart = null
        openingInProgress = false
        openingSnapshot = null
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
        clearSession()
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
        if (!isShowingRoundResult() && !result.value && players.length && !openingInProgress) {
          phase.value = 'revealing'
          revealHands.value = true
          const mapped = mapResult(msg.result)
          // 兜底分支同样播胡牌音效（与 startWinSequence 主路径对齐）
          playSound('zimo.mp3')
          winSequenceTimer = window.setTimeout(() => {
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
        leaveRemoteRoom()
        break
      case 'pong':
        // ping 的回应：测 RTT → 信号质量（越大越好）
        if (lastPingAt) signalQuality.value = rttToSignal(Date.now() - lastPingAt)
        break
      case 'error':
        handleError(msg.code)
        break
      default:
        break
    }
  }

  // ── WebSocket 连接 / 重连 ──────────────────────────────

  function connect() {
    if (!roomId.value || !rejoinCode.value || closedByUser) return
    wsStatus.value = 'connecting'
    const url = `${WS_BASE}/ws/room/${encodeURIComponent(roomId.value)}?rejoin_code=${encodeURIComponent(rejoinCode.value)}`
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    ws = socket
    socket.onopen = () => {
      wsStatus.value = 'connected'
      startPing()
    }
    socket.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data))
      } catch {
        // 非 JSON 消息忽略
      }
    }
    socket.onclose = () => {
      if (ws === socket) ws = null
      wsStatus.value = 'closed'
      signalQuality.value = 0   // 断开：信号归零
      if (!closedByUser && roomId.value) scheduleReconnect()
    }
    socket.onerror = () => {
      // onclose 随即触发，重连逻辑统一在 onclose
    }
  }

  function scheduleReconnect() {
    if (closedByUser || !roomId.value || reconnectTimer != null) return
    wsStatus.value = 'reconnecting'
    signalQuality.value = 0   // 重连中：信号归零
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 8000)
    reconnectAttempts += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function rttToSignal(rtt: number): number {
    if (rtt <= 80) return 3
    if (rtt <= 150) return 2
    if (rtt <= 300) return 1
    return 0
  }

  function startPing() {
    stopPing()
    pingTimer = window.setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        lastPingAt = Date.now()
        ws.send(JSON.stringify({ type: 'ping', t: lastPingAt }))
      }
    }, 5000)
  }

  function stopPing() {
    window.clearInterval(pingTimer as number)
    pingTimer = null
  }

  function closeConnection() {
    closedByUser = true
    window.clearTimeout(reconnectTimer as number)
    reconnectTimer = null
    stopPing()
    clearTimers()
    if (ws) {
      try {
        ws.onclose = null
        ws.close()
      } catch {
        // 已关闭
      }
      ws = null
    }
    wsStatus.value = 'idle'
  }

  // ── 匿名身份 / 会话持久化（Phase 8 P1）──────────────────

  function ensurePlayerId() {
    if (!playerId.value) {
      playerId.value = generateGuestId()
      saveStored(STORAGE.guestId, playerId.value)
    }
  }

  function readStoredSession(): StoredSession | null {
    const raw = loadStored(STORAGE.session)
    if (!raw) return null
    try {
      const session = JSON.parse(raw) as StoredSession
      return session?.rejoinCode ? session : null
    } catch {
      return null
    }
  }

  function persistSession() {
    if (!roomId.value || !rejoinCode.value) return
    const session: StoredSession = {
      roomId: roomId.value,
      rejoinCode: rejoinCode.value,
      nickname: nickname.value,
      playerId: playerId.value,
      mode: matchType.value,
    }
    saveStored(STORAGE.session, JSON.stringify(session))
    storedSession.value = session
    if (nickname.value) saveStored(STORAGE.nickname, nickname.value)   // 记住昵称：旧局战绩回退用
  }

  function clearSession() {
    clearStored(STORAGE.session)
    storedSession.value = null
  }

  async function resumeSession() {
    // 凭上次持久化的 rejoinCode 直接回原座位（对局中刷新/关浏览器后可「继续对局」）。
    const session = storedSession.value ?? readStoredSession()
    if (!session?.rejoinCode) return
    sessionError.value = ''
    roomId.value = session.roomId
    rejoinCode.value = session.rejoinCode
    nickname.value = session.nickname
    playerId.value = session.playerId || playerId.value
    matchType.value = session.mode || 'east'
    phase.value = 'lobby'
    matchFinished.value = false
    players.splice(0, players.length)
    closedByUser = false
    sessionStatus.value = 'connected'
    startPolling()
    connect()
  }

  // ── 房间生命周期（REST）───────────────────────────────

  function startPolling() {
    stopPolling()
    void refreshRoom()
    pollTimer = window.setInterval(() => void refreshRoom(), 1500)
  }

  function stopPolling() {
    window.clearInterval(pollTimer as number)
    pollTimer = null
  }

  async function refreshRoom() {
    if (!roomId.value) return
    // 对局进行中（phase ≠ lobby）不轮询：牌桌状态由 WS 快照驱动，座位面板不可见。
    // 回到大厅后 phase 回到 lobby，轮询自动恢复。
    if (phase.value !== 'lobby') return
    try {
      const info = await getRoom(roomId.value)
      roomSeats.value = info.seats ?? []
      // 房主以服务端 creatorSeat 为准：创建者离房后轮询自动转移「开始对局」按钮
      creatorSeat.value = info.creatorSeat ?? null
      isCreator.value = creatorSeat.value != null && mySeat.value === creatorSeat.value
    } catch {
      // 轮询失败静默，下次重试
    }
  }

  async function createRemoteRoom(mode: MatchType, capacity: number) {
    sessionError.value = ''
    sessionStatus.value = 'creating'
    try {
      const info = await createRoom(mode, capacity)
      isCreator.value = true
      ensurePlayerId()
      // 创建者也要占座（签发 rejoinCode 供 WS 握手恢复座位）
      const joined = await joinRoom(info.roomId, nickname.value, playerId.value)
      await enterRoom(joined.roomId, joined.nickname, info.mode, joined.rejoinCode)
    } catch (error) {
      sessionError.value = error instanceof Error ? error.message : '创建房间失败'
      sessionStatus.value = 'idle'
      throw error
    }
  }

  async function joinRemoteRoom(code: string) {
    sessionError.value = ''
    sessionStatus.value = 'joining'
    try {
      ensurePlayerId()
      const joined = await joinRoom(code.trim().toUpperCase(), nickname.value, playerId.value)
      isCreator.value = false
      await enterRoom(joined.roomId, joined.nickname, joined.rejoin ? matchType.value : 'east', joined.rejoinCode)
    } catch (error) {
      sessionError.value = error instanceof Error ? error.message : '加入房间失败'
      sessionStatus.value = 'idle'
      throw error
    }
  }

  async function enterRoom(id: string, name: string, mode: MatchType, code: string) {
    roomId.value = id
    matchType.value = mode
    nickname.value = name
    rejoinCode.value = code    // WS 握手凭 rejoin_code 恢复座位
    mySeat.value = -1          // rejoin_ok 会带上权威座位
    phase.value = 'lobby'
    matchFinished.value = false
    players.splice(0, players.length)
    closedByUser = false
    sessionStatus.value = 'connected'
    startPolling()
    connect()
    persistSession()   // 记录会话：刷新 / 关浏览器后可「继续对局」回原座位
  }

  async function toggleReady() {
    if (!roomId.value || mySeat.value < 0) return
    try {
      await readyRoom(roomId.value, mySeat.value, rejoinCode.value)
      await refreshRoom()
    } catch (error) {
      sessionError.value = error instanceof Error ? error.message : '准备失败'
    }
  }

  async function startMatch() {
    if (!roomId.value) return
    try {
      await startRoom(roomId.value)
    } catch (error) {
      sessionError.value = error instanceof Error ? error.message : '开局失败'
    }
  }

  async function leaveRemoteRoom() {
    closedByUser = true
    stopPolling()
    try {
      if (roomId.value && mySeat.value >= 0 && rejoinCode.value) {
        await leaveRoom(roomId.value, mySeat.value, rejoinCode.value)
      }
    } catch {
      // 已离开 / 房间已关闭时忽略
    }
    closeConnection()
    clearSession()   // 座位已释放，原会话不再可「继续对局」
    resetAll()
  }

  async function closeRemoteRoom() {
    if (!roomId.value || mySeat.value < 0 || !rejoinCode.value) return
    try {
      await closeRoom(roomId.value, mySeat.value, rejoinCode.value)
    } catch (error) {
      // 关闭失败（如房主已转移）：保留本地会话，仅提示；轮询会刷新房主身份
      sessionError.value = error instanceof Error ? error.message : '关闭房间失败'
      throw error
    }
    stopPolling()
    closeConnection()
    clearSession()
    resetAll()
  }

  // ── 重置 ───────────────────────────────────────────────

  function resetAll() {
    clearTimers()
    pendingSnapshot = null
    pendingRequest = null
    lastAnnouncementId = -1   // 新会话公告 id 从 1 重新计数
    lastDiscardIdApplied = -1
    pendingRoundStart = null
    openingInProgress = false
    openingSnapshot = null
    waitingNextRound.value = false
    openingStage.value = null
    phase.value = 'lobby'
    players.splice(0, players.length)
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
    sessionStatus.value = 'idle'
    wsStatus.value = 'idle'
    sessionError.value = ''
    signalQuality.value = 0
  }

  // ── 用户动作（发送到服务端，状态由快照权威回写）────────

  function send(message: Record<string, unknown>) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
    }
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
    cancelWinSequence()
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
      applyRequest(req)   // applyRequest 内部会按 openingInProgress 重新缓冲
    }
  }

  async function returnToLobby() {
    await leaveRemoteRoom()
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
    stopPolling()
    clearTimers()
  }
  const instance = getCurrentInstance()
  if (instance) onBeforeUnmount(cleanup)

  return {
    // 远程会话
    sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, rejoinCode,
    playerId, isCreator, creatorSeat, roomSeats, waitingNextRound,
    signalQuality,   // 0-3 信号质量（越大连接越好）
    storedSession,   // 上次未完成对局（「继续对局」入口；null = 无）
    remoteActions: {
      createRoom: createRemoteRoom,
      joinRoom: joinRemoteRoom,
      toggleReady,
      startMatch,
      leaveRoom: leaveRemoteRoom,
      closeRoom: closeRemoteRoom,
      resumeSession,
      refreshRoom,
    },
    // 游戏状态（useGame 兼容接口）
    phase, players, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
    actionPrompt, announcement, tableActionEvent, scoreFlowEvent, result, winEffect,
    winPresentation, revealHands, winningPlayerIndex,
    round, dealer, user, isUserTurn, userCanHu,
    matchType, matchName, matchFinished, honba, roundLabel, standings,
    dealAnimation, openingStage, diceValues, userCurrentWaits, userTingOptions, userDiscardWaits,
    userKongs, startGame, selectTile, clearUserSelection, userDiscard, userPass, userPeng,
    userGangFromDiscard, userGang, userHu, nextRound, returnToLobby, tileName, debugPreviewWin,
  }
}
