<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import MahjongTile from './components/MahjongTile.vue'
import MahjongTable3D from './components/MahjongTable3D.vue'
import PlayerSeat from './components/PlayerSeat.vue'
import RulesPanel from './components/RulesPanel.vue'
import { DISCLAIMER_SECTIONS, DISCLAIMER_TITLE, DISCLAIMER_VERSION } from './content/disclaimer'
import { isHorse } from './game/core/tiles'
import { BASE_SCORE } from './game/core/rules'
import { useGame } from './game/core/useGame'
import { useRemoteGame } from './game/online/useRemoteGame'
import { getPlayerStats, getPlayerStatsById, getRoomMeta, reportPlayer as reportPlayerApi, getDisclaimerAgreement, agreeDisclaimer } from './game/online/remoteApi'
import type { PlayerStats, RoomMeta } from './game/online/remoteApi'
import { useAudio } from './game/core/useAudio'
import { splitWinningTile } from './game/core/winEffect'
import { defaultAvatarForSeat } from './game/core/avatar'
import type { MatchType, TileType } from './game/core/types'

const rulesOpen = ref(false)
const resultVisible = ref(true)
const selectedMatch = ref<MatchType>('east')
const imageBase = `${import.meta.env.BASE_URL}img/`
const waitsOpen = ref(false)
const winEffectLab = import.meta.env.DEV && new URLSearchParams(window.location.search).has('winEffectLab')
const winEffectLabSeats = ['本家', '下家', '对家', '上家']
const requiresLandscape = ref(false)
const orientationMessage = ref('')
const hoveredDiscard = ref<TileType | null>(null)
const touchStarts = new Map<number, { index: number; x: number; y: number; startedAt: number }>()
let lastTouchTap = { index: -1, time: 0 }
let suppressTileClickUntil = 0
const { soundOn, playEffect, playEffectAndWait, startBgm, preloadBgm } = useAudio()
// 首次用户交互即预加载 BGM 到内存（fetch 无需手势，仅为提前下载；开局时播放零网络等待）。
const primeBgm = () => { preloadBgm() }
window.addEventListener('pointerdown', primeBgm, { once: true, passive: true })
window.addEventListener('keydown', primeBgm, { once: true })
window.addEventListener('touchstart', primeBgm, { once: true, passive: true })

function updateOrientationGate() {
  const isPortrait = window.matchMedia('(orientation: portrait)').matches
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
  const isMobileViewport = Math.min(window.innerWidth, window.innerHeight) <= 1024
  requiresLandscape.value = isPortrait && isTouchDevice && isMobileViewport

  if (!requiresLandscape.value) orientationMessage.value = ''
}

async function enterLandscapeFullscreen() {
  orientationMessage.value = ''

  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    }

    const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> }
    if (orientation?.lock) {
      await orientation.lock('landscape')
    }
  } catch (error) {
    orientationMessage.value = '当前浏览器无法自动旋转，请将手机横置后继续'
  } finally {
    updateOrientationGate()
  }
}

onMounted(() => {
  updateOrientationGate()
  window.addEventListener('resize', updateOrientationGate)
  window.addEventListener('orientationchange', updateOrientationGate)
  screen.orientation?.addEventListener?.('change', updateOrientationGate)
})

onUnmounted(() => {
  if (roomMetaTimer != null) window.clearInterval(roomMetaTimer)
  window.removeEventListener('resize', updateOrientationGate)
  window.removeEventListener('orientationchange', updateOrientationGate)
  screen.orientation?.removeEventListener?.('change', updateOrientationGate)
})

const gameMode = ref<'local' | 'remote'>('local')
const localGame = useGame({ playSound: playEffect, playSoundAndWait: playEffectAndWait })
const remoteGame = useRemoteGame({ playSound: playEffect, playSoundAndWait: playEffectAndWait })

// 模式切换桥：解构出的 ref / 函数始终委托给当前模式的 composable，
// 使本地 / 远程共用同一套模板与交互逻辑。
const gameFacade: Record<string, unknown> = {}
const activeGame = () => (gameMode.value === 'remote' ? remoteGame : localGame) as unknown as Record<string, unknown>
for (const key of Object.keys(localGame)) {
  const value = activeGame()[key]
  if (typeof value === 'function') {
    gameFacade[key] = (...args: unknown[]) => {
      const target = activeGame()[key] as (...a: unknown[]) => unknown
      return target(...args)
    }
  } else {
    gameFacade[key] = computed(() => {
      const source = activeGame()[key]
      // ref / computed → 取 .value；reactive 数组（players）→ 直接返回
      return source && typeof source === 'object' && 'value' in source
        ? (source as { value: unknown }).value
        : source
    })
  }
}
const game = gameFacade as unknown as ReturnType<typeof useGame>

const {
  phase, players, wall, wallHeadDrawn, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
  actionPrompt, announcement, tableActionEvent, scoreFlowEvent, result, winEffect, winPresentation, revealHands, winningPlayerIndex,
  round, dealer, user, isUserTurn, userCanHu,
  matchName, matchFinished, honba, roundLabel, standings,
  userKongs, userCurrentWaits, userTingOptions, userDiscardWaits, dealAnimation, openingStage, diceValues, startGame, selectTile, clearUserSelection, userDiscard, userPass, userPeng, userGangFromDiscard,
  userGang, userHu, nextRound, returnToLobby, debugPreviewWin,
} = game

// ── 联机模式状态（远程房间 / WS 连接）──────────────────
const {
  sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, playerId, isCreator, roomSeats, roomTimeLimit, remoteActions, waitingNextRound, storedSession, signalQuality, autoPlay, toggleAutoPlay,
} = remoteGame
function readStoredNickname() {
  try { return localStorage.getItem('lgm_nickname') || '' } catch { return '' }
}
const nicknameInput = ref(readStoredNickname())
const joinCode = ref('')
const allOccupiedReady = computed(() => {
  const occupied = roomSeats.value.filter(Boolean)
  return occupied.length > 0 && occupied.every((seat) => seat?.ready)
})
// 网络信号：0-3 格的语义是「连接健康度」，而非延迟（棋牌类对延迟不敏感）
const signalText = computed(() =>
  ({ 0: '网络不稳定', 1: '网络波动', 2: '网络良好', 3: '网络流畅' })[signalQuality.value] ?? '')

// 大厅房间容量：轮询 GET /api/rooms/meta，剩余房间 = max - active（进房后停止）
const roomMeta = ref<RoomMeta | null>(null)
let roomMetaTimer: number | null = null
async function refreshRoomMeta() {
  try {
    roomMeta.value = await getRoomMeta()
  } catch {
    // 网络抖动静默：大厅不因容量查询失败而报错
  }
}
watch([gameMode, roomId], ([mode, id]) => {
  if (mode === 'remote' && !id) {
    void refreshRoomMeta()
    if (roomMetaTimer == null) {
      roomMetaTimer = window.setInterval(refreshRoomMeta, 5000)
    }
  } else if (roomMetaTimer != null) {
    window.clearInterval(roomMetaTimer)
    roomMetaTimer = null
  }
}, { immediate: true })

// ── 纯娱乐声明：首次创建/加入房间前需确认。
// 确认记录 localStorage（本机记忆）+ 同步服务端账号（换浏览器/设备也记住，Phase 8 P1）。
const DISCLAIMER_STORAGE_KEY = 'lgm_disclaimer_agreed'
const disclaimerOpen = ref(false)
let pendingRoomAction: (() => void) | null = null

function hasAgreedDisclaimer(): boolean {
  try { return localStorage.getItem(DISCLAIMER_STORAGE_KEY) === '1' } catch { return false }
}

async function guardRoomEntry(action: () => void) {
  if (hasAgreedDisclaimer()) {
    action()
    return
  }
  // 本地无记录：查服务端（换浏览器 / 清 localStorage 后仍能记住「已确认」）
  if (playerId.value) {
    try {
      const server = await getDisclaimerAgreement(playerId.value)
      if (server.agreed && (server.version ?? 0) >= DISCLAIMER_VERSION) {
        try { localStorage.setItem(DISCLAIMER_STORAGE_KEY, '1') } catch { /* 忽略 */ }
        action()
        return
      }
    } catch {
      // 后端不可达：降级为本地弹窗确认
    }
  }
  pendingRoomAction = action
  disclaimerOpen.value = true
}

function acceptDisclaimer() {
  try { localStorage.setItem(DISCLAIMER_STORAGE_KEY, '1') } catch { /* localStorage 不可用时本次仍放行 */ }
  // 同步到服务端账号；失败静默（本地已兜底，下次进房不再询问）
  if (playerId.value) {
    void agreeDisclaimer(playerId.value).catch(() => { /* 忽略 */ })
  }
  disclaimerOpen.value = false
  const action = pendingRoomAction
  pendingRoomAction = null
  action?.()
}

function declineDisclaimer() {
  disclaimerOpen.value = false
  pendingRoomAction = null
}

function createRemoteRoom() {
  if (roomId.value) return   // 已在房间：禁重复建房（按钮禁用，回车路径同样拦截）
  if (!nicknameInput.value.trim()) return
  nickname.value = nicknameInput.value.trim()
  guardRoomEntry(() => void remoteActions.createRoom(selectedMatch.value, 4))
}

function joinRemoteRoom() {
  if (roomId.value) return   // 已在房间：禁重复加入
  if (!nicknameInput.value.trim() || !joinCode.value.trim()) return
  nickname.value = nicknameInput.value.trim()
  guardRoomEntry(() => void remoteActions.joinRoom(joinCode.value))
}

// 房间码一键复制：优先 Clipboard API；局域网 http 非安全上下文回退隐藏 textarea + execCommand
const copied = ref(false)
async function copyRoomCode() {
  const code = roomId.value
  if (!code) return
  let ok = false
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(code); ok = true } catch { ok = false }
  }
  if (!ok) {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = code
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.top = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      ok = document.execCommand('copy')
      document.body.removeChild(textarea)
    } catch { ok = false }
  }
  if (ok) {
    copied.value = true
    window.setTimeout(() => { copied.value = false }, 1600)
  }
}

// 外部头像（联机真人）加载失败 → 回退本地座位默认头像。
// 结算/排名条目带 fallbackAvatar（结算页按服务端座位预先算好）或 seat（牌桌座位）。
function onAvatarError(entry?: { avatar?: string; seat?: number; fallbackAvatar?: string }) {
  if (!entry) return
  const target = entry.fallbackAvatar ?? (entry.seat != null ? defaultAvatarForSeat(entry.seat) : '')
  if (target && entry.avatar !== target) entry.avatar = target
}

function startGameWithAudio() {
  startBgm()
  // 音效在后台缓存，不能阻塞玩家创建和 3D 牌桌首次渲染。
  startGame(selectedMatch.value)
}

const matchStarting = ref(false)   // 「正在打扫房间」：房主点击开始到开局快照落地之间的过渡态
async function startRemoteMatch() {
  matchStarting.value = true
  try {
    // 不在点击瞬间播 BGM：等 WS 开局快照（phase 离开 lobby）进入房间后再播
    await remoteActions.startMatch()
  } catch {
    // 开局失败（composable 已写 sessionError）：复位按钮态供房主重试
    matchStarting.value = false
  }
}
// 远程开局（phase 离开 lobby）才播 BGM，与本地 startGameWithAudio 的进桌时机对齐
watch(phase, (value) => {
  if (gameMode.value === 'remote' && value !== 'lobby') startBgm()
  matchStarting.value = false
})

function quitMatch() {
  // 中途退出：释放座位 + 关闭 WS，回大厅（服务端该座位转 AI 代打剩余对局）
  if (window.confirm('退出对局将放弃本场对局（座位由 AI 代打），确定退出？')) {
    void remoteActions.leaveRoom()
  }
}

// 房间面板：离开 / 关闭需要 in-flight 提示，且进行中禁止重复操作
const leaving = ref(false)
const closing = ref(false)
async function leaveRoom() {
  if (leaving.value || closing.value) return
  leaving.value = true
  try {
    await remoteActions.leaveRoom()
  } finally {
    leaving.value = false
  }
}
async function closeRoom() {
  if (leaving.value || closing.value) return
  closing.value = true
  try {
    await remoteActions.closeRoom()
  } finally {
    closing.value = false
  }
}

// 继续对局（P1）：凭 localStorage 会话直接回上次未完成对局的原座位（同为进房，需先确认声明）
function resumeRemoteSession() {
  guardRoomEntry(() => {
    gameMode.value = 'remote'
    void remoteActions.resumeSession()
  })
}

// 举报（P1）：报告当前房间里的某位玩家（后端 resolves player_id 以便封禁）
async function reportPlayer(name: string) {
  if (!playerId.value) return
  const reason = window.prompt(`举报「${name}」的原因？（对局中违规 / 作弊 / 赌博引流 等）`, '对局中违规')
  if (reason == null) return
  try {
    await reportPlayerApi({
      roomId: roomId.value,
      reporterPlayerId: playerId.value,
      targetName: name,
      reason,
    })
    window.alert('举报已提交，感谢反馈')
  } catch {
    window.alert('举报提交失败，请稍后再试')
  }
}

// ── 战绩页：个人统计（服务端 /api/players/{nickname}/stats）──
const statsOpen = ref(false)
const playerStats = ref<PlayerStats | null>(null)
const statsLoading = ref(false)

async function openStats() {
  statsOpen.value = true
  statsLoading.value = true
  playerStats.value = null
  try {
    // 身份锚点是 guestId（启动即生成），无需先填昵称/进房
    playerStats.value = await getPlayerStatsById(playerId.value)
    // 旧局（P1 前无 player_id）回退昵称查询：用当前/已记忆的昵称
    if (playerStats.value.matches === 0) {
      const name = nickname.value || nicknameInput.value.trim() || readStoredNickname()
      if (name) {
        const byName = await getPlayerStats(name)
        if (byName.matches > 0) playerStats.value = byName
      }
    }
  } catch {
    playerStats.value = null
  } finally {
    statsLoading.value = false
  }
}

const seatPosition = ['bottom', 'right', 'top', 'left']
const tableActionPosition = computed(() => tableActionEvent.value ? seatPosition[tableActionEvent.value.actorIndex] : 'bottom')
const tableActionLabel = computed(() => ({
  peng: '碰',
  'discard-gang': '杠',
  'concealed-gang': '杠',
  'added-gang': '杠',
  'flower-gang': '杠',
  'self-draw': '自摸',
  'robbed-kong-win': '抢杠胡',
}[tableActionEvent.value?.type ?? 'peng']))
const tableActionIsWin = computed(() => ['self-draw', 'robbed-kong-win'].includes(tableActionEvent.value?.type ?? ''))
const scoreDeltaFor = (playerIndex: number) => scoreFlowEvent.value?.deltas.find((delta) => delta.playerIndex === playerIndex)?.amount ?? 0

watch(result, (value) => {
  resultVisible.value = Boolean(value)
})

watch(userDiscardWaits, (value) => {
  waitsOpen.value = Boolean(value)
})

watch(isUserTurn, (value) => {
  if (!value) waitsOpen.value = false
})

// ── 联机结算「继续」按钮：10s 倒计时，超时自动确认（服务端同样有兜底超时）──
const continueCountdown = ref(10)
let continueTimer: number | null = null

function stopContinueCountdown() {
  if (continueTimer != null) {
    window.clearInterval(continueTimer)
    continueTimer = null
  }
  continueCountdown.value = 10
}

function startContinueCountdown() {
  stopContinueCountdown()
  continueCountdown.value = 10
  continueTimer = window.setInterval(() => {
    continueCountdown.value -= 1
    if (continueCountdown.value <= 0) {
      stopContinueCountdown()
      nextRound()
    }
  }, 1000)
}

// 倒计时不依赖结算页是否展开：无论用户在看结算还是看牌桌，都会自动确认。
// 已确认（waitingNextRound）后停止倒计时，等所有玩家确认服务端推进。
watch([result, phase, gameMode, matchFinished, waitingNextRound], () => {
  const countdownActive = gameMode.value === 'remote'
    && phase.value === 'settled'
    && Boolean(result.value)
    && !waitingNextRound.value
    && !matchFinished.value
  if (countdownActive) startContinueCountdown()
  else stopContinueCountdown()
})

const hoveredWaits = computed(() => hoveredDiscard.value
  ? userTingOptions.value.find((option) => option.discard === hoveredDiscard.value) ?? null
  : null)
const activeWaits = computed(() => hoveredWaits.value || userDiscardWaits.value || (!isUserTurn.value ? userCurrentWaits.value : null))
const tingDiscardTiles = computed(() => new Set(userTingOptions.value.map((option) => option.discard)))
const displayedUserHand = computed(() => {
  if (winPresentation.value?.winnerIndex !== 0) return user.value.hand
  return splitWinningTile(user.value.hand, winPresentation.value).hand
})

// 摸牌位：手牌比基准（13 - 3×非花副露数）多出一张即视为「摸牌」并留间隙；
// drawnTileIndex 有效时用它，否则取末张（与 3D addConcealedHand 保持一致）。
const userDrawnTileIndex = computed(() => {
  const hand = displayedUserHand.value
  const baseHand = 13 - 3 * user.value.melds.filter((m) => m.type !== 'flower').length
  const raw = user.value.drawnTileIndex
  return raw >= 0 && raw < hand.length ? raw : (hand.length > baseHand ? hand.length - 1 : -1)
})

function usesFinePointer() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

function previewDesktopWaits(tile: TileType) {
  if (!isUserTurn.value || !usesFinePointer() || !tingDiscardTiles.value.has(tile)) return
  hoveredDiscard.value = tile
  waitsOpen.value = true
}

function clearDesktopWaits() {
  if (!usesFinePointer() || !hoveredDiscard.value) return
  hoveredDiscard.value = null
  waitsOpen.value = false
}

function beginTileGesture(index: number, event: PointerEvent) {
  if (!['touch', 'pen'].includes(event.pointerType)) return
  touchStarts.set(event.pointerId, {
    index,
    x: event.clientX,
    y: event.clientY,
    startedAt: performance.now(),
  })
  ;(event.currentTarget as HTMLElement)?.setPointerCapture?.(event.pointerId)
}

function finishTileGesture(index: number, event: PointerEvent) {
  const start = touchStarts.get(event.pointerId)
  touchStarts.delete(event.pointerId)
  if (!start || start.index !== index || !isUserTurn.value) return
  const deltaX = event.clientX - start.x
  const deltaY = event.clientY - start.y
  const upwardDistance = -deltaY
  if (upwardDistance >= 28 && upwardDistance > Math.abs(deltaX) * 1.15 && performance.now() - start.startedAt < 700) {
    suppressTileClickUntil = performance.now() + 500
    lastTouchTap = { index: -1, time: 0 }
    hoveredDiscard.value = null
    waitsOpen.value = false
    userDiscard(index)
  }
}

function cancelTileGesture(event: PointerEvent) {
  touchStarts.delete(event.pointerId)
}

function handleTileActivation(index: number, event?: PointerEvent) {
  if (!isUserTurn.value) return
  const now = performance.now()
  if (now < suppressTileClickUntil) return
  const pointerType = event?.pointerType
  const isTouch = pointerType === 'touch' || pointerType === 'pen' || !usesFinePointer()
  if (!isTouch) {
    hoveredDiscard.value = null
    waitsOpen.value = false
    userDiscard(index)
    return
  }

  if (lastTouchTap.index === index && now - lastTouchTap.time <= 360) {
    lastTouchTap = { index: -1, time: 0 }
    waitsOpen.value = false
    userDiscard(index)
    return
  }

  lastTouchTap = { index, time: now }
  selectTile(index)
}

function clearMobileSelection(event: PointerEvent) {
  if (usesFinePointer() || selectedIndex.value < 0 || event.pointerType === 'mouse') return
  const target = event.target as HTMLElement
  if (target.closest('.hand-tile-slot, .waiting-tip, .action-bar')) return
  clearUserSelection()
  waitsOpen.value = false
  lastTouchTap = { index: -1, time: 0 }
}
</script>

<template>
  <div v-if="requiresLandscape" class="orientation-gate" role="dialog" aria-modal="true" aria-labelledby="orientation-title">
    <div class="orientation-card">
      <div class="phone-rotate-icon" aria-hidden="true"><span></span></div>
      <p class="eyebrow">LANDSCAPE MODE</p>
      <h2 id="orientation-title">请横屏游玩</h2>
      <p>为了完整显示牌桌，请进入全屏并将手机旋转为横屏。</p>
      <button type="button" @click="enterLandscapeFullscreen">进入全屏横屏</button>
      <small v-if="orientationMessage" role="status">{{ orientationMessage }}</small>
    </div>
  </div>
  <main class="game-app">
    <div v-if="gameMode === 'remote' && wsStatus === 'reconnecting'" class="remote-banner" role="status">网络断开，正在重连…</div>
    <div v-else-if="gameMode === 'remote' && wsStatus === 'closed' && roomId" class="remote-banner error" role="status">连接已断开，正在尝试恢复…</div>
    <div v-if="gameMode === 'remote' && waitingNextRound" class="remote-banner" role="status">已确认，等待其他玩家…</div>
    <div class="wood-frame">
      <div class="felt-table" :class="{ 'has-three-scene': players.length }" @pointerdown="clearMobileSelection">
        <header class="top-bar">
          <div class="brand-mini"><span v-if="!players.length">莲花广麻</span></div>
          <div class="round-info">{{ matchName }} · {{ roundLabel }}<span v-if="honba"> · {{ honba }}本场</span></div>
          <div v-if="players.length" class="base-score-badge">
            <span v-if="gameMode === 'remote' && roomId" class="badge-room">房间 {{ roomId }}</span>
            <span>底分{{ BASE_SCORE }}</span>
            <img
              v-if="gameMode === 'remote'"
              class="signal-icon"
              :src="`${imageBase}signal-${signalQuality}.png`"
              :alt="signalText"
              :title="signalQuality <= 1 ? `${signalText}，可能被 AI 托管` : signalText"
            />
            <span v-if="gameMode === 'remote' && signalQuality <= 1" class="signal-warn">{{ signalText }}</span>
          </div>
          <nav>
            <button
              v-if="gameMode === 'remote' && phase !== 'lobby'"
              class="quit-match"
              aria-label="退出对局"
              title="退出对局"
              @click="quitMatch"
            ><img :src="`${imageBase}door-open.svg`" alt="" /></button>
            <button class="icon-button" :aria-label="soundOn ? '关闭声音' : '开启声音'" @click="soundOn = !soundOn">
              <img :src="`${imageBase}${soundOn ? 'audio.png' : 'mute.png'}`" alt="" />
            </button>
            <button class="icon-button" aria-label="查看规则" @click="rulesOpen = true">
              <img :src="`${imageBase}manual.png`" alt="" />
            </button>
          </nav>
        </header>
        <div class="table-depth" aria-hidden="true">
          <i class="table-edge edge-top"></i>
          <i class="table-edge edge-right"></i>
          <i class="table-edge edge-bottom"></i>
          <i class="table-edge edge-left"></i>
        </div>

        <template v-if="players.length">
          <MahjongTable3D
            :players="players"
            :current-player="currentPlayer"
            :last-discard="lastDiscard"
            :wall="wall"
            :wall-head-drawn="wallHeadDrawn"
            :wall-count="wallCount"
            :horses="result?.horses"
            :reveal-hands="revealHands"
            :winner-index="winningPlayerIndex"
            :win-effect="winEffect"
            :win-presentation="winPresentation"
            :deal-animation="dealAnimation"
            :opening-stage="openingStage"
            :dice-values="diceValues"
            :dealer-index="dealer"
            :table-action-event="tableActionEvent"
          />
          <PlayerSeat
            v-for="(player, index) in players.slice(1)"
            :key="player.seat"
            :player="player"
            :position="seatPosition[index + 1]"
            :active="currentPlayer === index + 1"
            :action-active="tableActionEvent?.actorIndex === index + 1"
            :score-delta="scoreDeltaFor(index + 1)"
            :score-flow-id="scoreFlowEvent?.id"
            :dealer="dealer === index + 1"
            :render-hand="false"
            :render-melds="false"
          />

          <Transition name="table-action" mode="out-in">
            <div
              v-if="tableActionEvent"
              :key="tableActionEvent.id"
              class="table-action-cue"
              :class="[`action-from-${tableActionPosition}`, { gang: tableActionLabel === '杠', win: tableActionIsWin }]"
              aria-live="polite"
            ><span>{{ tableActionLabel }}</span></div>
          </Transition>

          <Transition name="announce">
            <div v-if="announcement" :key="announcement.id" class="announcement" :class="announcement.tone">
              <span>{{ announcement.text }}</span>
            </div>
          </Transition>

          <Transition name="opening-cue" mode="out-in">
            <div v-if="openingStage === 'start'" key="start" class="opening-overlay start-cue">
              <span>{{ matchName }} · {{ roundLabel }}</span>
              <strong>对局开始</strong>
              <i></i>
            </div>
          </Transition>

          <section class="user-area">
            <div class="user-identity" :class="{ active: currentPlayer === 0, 'action-active': tableActionEvent?.actorIndex === 0 }">
              <span v-if="dealer === 0" class="dealer-badge">庄</span>
              <img class="avatar" :src="user.avatar" :alt="`${user.name}头像`" @error="onAvatarError(user)" />
              <div class="player-info"><strong>{{ user.name }}</strong><span>{{ user.score }}</span></div>
            </div>
            <Transition name="score-flow">
              <strong
                v-if="scoreDeltaFor(0)"
                :key="`${scoreFlowEvent?.id}-0`"
                class="score-delta user-score-delta"
                :class="scoreDeltaFor(0) > 0 ? 'positive' : 'negative'"
              >{{ scoreDeltaFor(0) > 0 ? '+' : '' }}{{ scoreDeltaFor(0) }}</strong>
            </Transition>
            <div class="hand-rack" :class="{ playable: isUserTurn, dealing: phase === 'dealing', 'has-melds': user.melds.length }">
              <div
                v-for="(tile, index) in displayedUserHand"
                :key="`${tile}-${index}`"
                class="hand-tile-slot"
                :class="{ drawn: user.drawnTileIndex === index, 'ting-discard': isUserTurn && tingDiscardTiles.has(tile) }"
                @mouseenter="previewDesktopWaits(tile)"
                @mouseleave="clearDesktopWaits"
                @pointerdown.stop="beginTileGesture(index, $event)"
                @pointerup.stop="finishTileGesture(index, $event)"
                @pointercancel="cancelTileGesture"
              >
                <span
                  v-if="isUserTurn && tingDiscardTiles.has(tile)"
                  class="ting-arrow"
                  aria-hidden="true"
                ></span>
                <MahjongTile
                  :tile="tile"
                  :selected="selectedIndex === index"
                  :drawn="user.drawnTileIndex === index"
                  :disabled="!isUserTurn"
                  @choose="handleTileActivation(index, $event)"
                />
              </div>
            </div>
          </section>

          <div v-if="isUserTurn || actionPrompt" class="turn-timer" :class="{ 'prompt-timer': actionPrompt }">
            <span>{{ turnSeconds }}</span>
          </div>

          <div v-if="activeWaits && waitsOpen" class="waiting-tip compact-waiting-tip">
            <template v-if="activeWaits.any">
              <strong>听任意</strong>
              <em>{{ activeWaits.remaining }}张</em>
            </template>
            <template v-else>
              <div class="waiting-tiles">
                <div v-for="item in activeWaits.tiles" :key="item.tile">
                  <MahjongTile :tile="item.tile" small disabled />
                  <small>{{ item.remaining }}张</small>
                </div>
              </div>
            </template>
          </div>

          <div v-if="actionPrompt || isUserTurn || userCurrentWaits" class="action-bar">
              <button
                v-if="userCurrentWaits || userTingOptions.length"
                class="action waiting-action"
                :class="{ active: waitsOpen }"
                aria-label="查看听牌提示"
                :aria-expanded="waitsOpen"
                @click="waitsOpen = !waitsOpen"
              ><img class="action-icon" :src="`${imageBase}tips.png`" alt="" /></button>
              <template v-if="actionPrompt?.type === 'claim'">
                <button class="action primary" @click="userPeng"><b>碰</b></button>
                <button v-if="actionPrompt.canGang" class="action primary" @click="userGangFromDiscard"><b>杠</b></button>
                <button class="action pass" @click="userPass"><b>过</b></button>
              </template>
              <template v-else-if="actionPrompt?.type === 'rob'">
                <button class="action hu" @click="userHu"><b>胡</b></button>
                <button class="action pass" @click="userPass"><b>过</b></button>
              </template>
              <template v-else>
                <button v-if="userKongs.length" class="action primary" @click="userGang()"><b>杠</b></button>
                <button v-if="userCanHu" class="action hu" @click="userHu"><b>胡</b></button>
              </template>
          </div>
        </template>

        <section v-if="phase === 'lobby'" class="lobby">
          <p class="eyebrow">LINGNAN GUANGDONG MAHJONG</p>
          <h1>莲花<span>广麻</span></h1>
          <p class="subtitle">一款莲花县特有的地方麻将游戏玩法</p>
          <button
            v-if="storedSession && !roomId"
            class="continue-session"
            @click="resumeRemoteSession"
          >⏵ 继续对局<template v-if="storedSession.roomId">（房间 {{ storedSession.roomId }}）</template></button>
          <div class="mode-selector" role="radiogroup" aria-label="游戏模式">
            <button :class="{ active: gameMode === 'local' }" role="radio" :aria-checked="gameMode === 'local'" @click="gameMode = 'local'"><b>单机对战</b><span>与 AI 同桌</span></button>
            <button :class="{ active: gameMode === 'remote' }" role="radio" :aria-checked="gameMode === 'remote'" @click="gameMode = 'remote'"><b>联机对战</b><span>创建或加入房间</span></button>
          </div>

          <template v-if="gameMode === 'local'">
            <div class="match-selector" role="radiogroup" aria-label="场次选择">
              <button :class="{ active: selectedMatch === 'east' }" role="radio" :aria-checked="selectedMatch === 'east'" @click="selectedMatch = 'east'"><b>东风场</b><span>一场4局（不含连庄）</span></button>
              <button :class="{ active: selectedMatch === 'hanchan' }" role="radio" :aria-checked="selectedMatch === 'hanchan'" @click="selectedMatch = 'hanchan'"><b>半庄场</b><span>一场8局（不含连庄）</span></button>
            </div>
            <button class="start-button" @click="startGameWithAudio"><b>开始{{ selectedMatch === 'east' ? '东风场' : '半庄场' }}</b><span>四人对局</span></button>
          </template>

          <template v-else>
            <div class="remote-lobby">
              <label class="remote-field">
                <span>昵称</span>
                <input
                  v-model="nicknameInput"
                  maxlength="12"
                  placeholder="输入昵称"
                  @keyup.enter="joinCode ? joinRemoteRoom() : createRemoteRoom()"
                />
              </label>
              <p v-if="roomMeta && !roomId" class="room-meta-note" role="status">
                剩余房间 <b>{{ roomMeta.max - roomMeta.active }}</b> / {{ roomMeta.max }}
              </p>
              <div v-if="!roomId" class="match-selector" role="radiogroup" aria-label="场次选择">
                <button :class="{ active: selectedMatch === 'east' }" role="radio" :aria-checked="selectedMatch === 'east'" @click="selectedMatch = 'east'"><b>东风场</b><span>一场4局（不含连庄）</span></button>
                <button :class="{ active: selectedMatch === 'hanchan' }" role="radio" :aria-checked="selectedMatch === 'hanchan'" @click="selectedMatch = 'hanchan'"><b>半庄场</b><span>一场8局（不含连庄）</span></button>
              </div>
              <div class="remote-actions">
                <button class="remote-create" :disabled="!nicknameInput.trim() || sessionStatus === 'creating' || !!roomId" @click="createRemoteRoom">
                  {{ sessionStatus === 'creating' ? '创建中…' : '创建房间' }}
                </button>
                <div class="remote-join">
                  <input v-model="joinCode" maxlength="6" placeholder="6 位房间码" @keyup.enter="joinRemoteRoom()" />
                  <button class="remote-join-btn" :disabled="!nicknameInput.trim() || !joinCode.trim() || sessionStatus === 'joining' || !!roomId" @click="joinRemoteRoom">
                    {{ sessionStatus === 'joining' ? '加入中…' : '加入房间' }}
                  </button>
                </div>
              </div>
              <p v-if="sessionError" class="session-error" role="alert">{{ sessionError }}</p>

              <div v-if="roomId" class="room-panel">
                <div class="room-code" title="点击复制房间码" role="button" tabindex="0" @click="copyRoomCode" @keyup.enter="copyRoomCode">
                  房间码 <strong>{{ roomId }}</strong><span v-if="copied" class="room-code-copied">已复制</span>
                </div>
                <p v-if="roomTimeLimit" class="room-limit-note">
                  房间限时 {{ Math.round(roomTimeLimit / 60) }} 分钟，超时自动解散；房主离开将解散房间。
                </p>
                <div class="room-seats">
                  <div v-for="(seat, index) in roomSeats" :key="index" class="room-seat" :class="{ occupied: !!seat }">
                    <span class="room-seat-no">{{ index + 1 }}</span>
                    <b>{{ seat?.nickname || '等待加入…' }}</b>
                    <em v-if="seat?.ready">已准备</em>
                    <em v-else-if="seat" class="unready">未准备</em>
                  </div>
                </div>
                <div class="room-owner-actions">
                  <button v-if="mySeat >= 0" class="secondary" :disabled="sessionStatus === 'readying'" @click="remoteActions.toggleReady()">准备 / 取消准备</button>
                  <button
                    v-if="isCreator"
                    class="start-button room-start"
                    :disabled="!allOccupiedReady || matchStarting"
                    @click="startRemoteMatch"
                  ><b>开始对局</b><span>{{ matchStarting ? '正在打扫房间' : (allOccupiedReady ? '全员已准备' : '等待全员准备') }}</span></button>
                </div>
                <div class="room-actions-row">
                  <button class="text-button room-leave" :disabled="leaving || closing" @click="leaveRoom">{{ leaving ? '离开中…' : '离开房间' }}</button>
                  <button v-if="isCreator" class="text-button room-close" :disabled="leaving || closing" @click="closeRoom">{{ closing ? '关闭中…' : '关闭房间' }}</button>
                </div>
              </div>
            </div>
          </template>

          <div class="lobby-links">
            <button
              v-if="gameMode === 'remote'"
              class="text-button"
              @click="openStats"
            >我的战绩 →</button>
            <button class="text-button" @click="rulesOpen = true">游戏规则 →</button>
            <a
              class="repository-link"
              href="https://github.com/BestGuo2020/lianhuaguangdongmahjong"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="在 GitHub 新标签页打开莲花广麻仓库"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.24c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A11 11 0 0 1 12 6.1c.98 0 1.95.13 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.26c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg>
              GitHub ↗
            </a>
          </div>
        </section>

        <Transition name="modal">
          <div v-if="result && resultVisible && !matchFinished" class="result-backdrop round-settlement">
            <section class="result-card settlement-card">
              <h2>{{ result.roundLabel }} · {{ result.draw ? '流局' : (result.robbedKong ? '抢杠胡' : '自摸') }}</h2>
              <div v-if="!result.draw" class="score-total"><span>总倍数</span><strong>×{{ result.totalMultiplier ?? result.multiplier }}</strong><em>+{{ result.totalWon ?? result.points * 3 }} 分</em></div>
              <div v-if="result.details?.length" class="score-details">
                <span v-for="detail in result.details" :key="detail.label">
                  {{ detail.label }} <b>{{ detail.points != null ? `+${detail.points} 分` : `×${detail.multiplier}` }}</b>
                </span>
              </div>
              <div v-if="result.horses?.length" class="horse-area">
                <div>
                  <MahjongTile
                    v-for="(tile, index) in result.horses"
                    :key="index"
                    :tile="tile"
                    :class="{ 'horse-hit': isHorse(tile) }"
                    small
                    disabled
                  />
                </div>
              </div>
              <div class="round-rankings">
                <article v-for="entry in result.scoreChanges" :key="entry.playerIndex" :class="{ winner: entry.playerIndex === result.winnerIndex }">
                  <strong class="rank-number">{{ entry.rank }}<small>位</small></strong>
                  <img :src="entry.avatar" :alt="`${entry.name}头像`" @error="onAvatarError(entry)" />
                  <span class="player-line">
                    {{ entry.name }}
                    <i v-if="entry.playerIndex === dealer" class="mark dealer">庄</i>
                    <i v-if="result.draw && result.tenpai?.includes(entry.playerIndex)" class="mark tenpai">听</i>
                  </span>
                  <em :class="{ positive: entry.delta > 0, negative: entry.delta < 0 }">{{ entry.delta > 0 ? '+' : '' }}{{ entry.delta }}</em>
                  <b>{{ entry.score }}</b>
                </article>
              </div>
              <div class="result-actions">
                <button class="secondary" @click="resultVisible = false">查看牌桌</button>
                <button @click="nextRound" :disabled="waitingNextRound">
                  <template v-if="waitingNextRound">等待其他玩家确定...</template>
                  <template v-else>继续<template v-if="gameMode === 'remote' && continueCountdown > 0"> ({{ continueCountdown }})</template></template>
                </button>
              </div>
              <p class="result-disclaimer-note">游戏结果禁止用于赌博行为</p>
            </section>
          </div>
        </Transition>
        <Transition name="final-board">
          <div v-if="matchFinished" class="result-backdrop final-backdrop">
            <section class="final-board">
              <p>{{ matchName }} · 对局结束</p>
              <h2>最终排名</h2>
              <div class="final-rankings">
                <article v-for="entry in standings" :key="entry.playerIndex" :class="[`rank-${entry.rank}`, { self: entry.playerIndex === 0 }]">
                  <div class="final-rank"><b>{{ entry.rank }}</b><span>位</span></div>
                  <img :src="entry.avatar" :alt="`${entry.name}头像`" @error="onAvatarError(entry)" />
                  <div class="final-name">
                    <strong>{{ entry.name }}</strong>
                    <small v-if="entry.playerIndex === 0">你</small>
                    <button v-if="entry.playerIndex !== 0 && playerId" class="report-link" @click="reportPlayer(entry.name)">举报</button>
                  </div>
                  <em>{{ entry.score }}</em>
                </article>
              </div>
              <button @click="returnToLobby">返回大厅</button>
              <p class="result-disclaimer-note">游戏结果禁止用于赌博行为</p>
            </section>
          </div>
        </Transition>
        <Transition name="modal">
          <div v-if="statsOpen" class="result-backdrop round-settlement">
            <section class="result-card settlement-card stats-card">
              <h2>个人战绩</h2>
              <p class="stats-nickname">{{ nickname || nicknameInput }}</p>
              <div v-if="statsLoading" class="stats-loading">加载中…</div>
              <template v-else-if="playerStats">
                <div class="stats-grid">
                  <article><b>{{ playerStats.matches }}</b><span>场次</span></article>
                  <article><b>{{ playerStats.hands }}</b><span>参与局数</span></article>
                  <article><b>{{ playerStats.wins }}</b><span>胡牌局数</span></article>
                  <article><b :class="{ positive: playerStats.totalDelta > 0, negative: playerStats.totalDelta < 0 }">{{ playerStats.totalDelta > 0 ? '+' : '' }}{{ playerStats.totalDelta }}</b><span>净胜分</span></article>
                </div>
              </template>
              <p v-else class="stats-empty">暂无战绩记录，快去打一局吧！</p>
              <div class="result-actions">
                <button @click="statsOpen = false">关闭</button>
              </div>
            </section>
          </div>
        </Transition>
        <Transition name="modal">
          <div v-if="disclaimerOpen" class="result-backdrop disclaimer-backdrop" role="dialog" aria-modal="true" aria-labelledby="disclaimer-title">
            <section class="result-card disclaimer-card">
              <h2 id="disclaimer-title">{{ DISCLAIMER_TITLE }}</h2>
              <div class="disclaimer-scroll">
                <template v-for="(section, index) in DISCLAIMER_SECTIONS" :key="index">
                  <h3 v-if="section.title">{{ section.title }}</h3>
                  <p v-if="section.body">{{ section.body }}</p>
                  <ol v-if="section.list?.length">
                    <li v-for="(item, itemIndex) in section.list" :key="itemIndex">{{ item }}</li>
                  </ol>
                </template>
              </div>
              <div class="result-actions">
                <button class="secondary" @click="declineDisclaimer">不同意，返回</button>
                <button @click="acceptDisclaimer">同意并继续</button>
              </div>
            </section>
          </div>
        </Transition>
        <button v-if="result && !resultVisible && !matchFinished" class="result-reopen" @click="resultVisible = true">查看结算</button>
        <button
          v-if="gameMode === 'remote' && result && !resultVisible && !matchFinished"
          class="result-reopen continue"
          @click="nextRound"
          :disabled="waitingNextRound"
        ><template v-if="waitingNextRound">等待其他玩家确定...</template><template v-else>继续<template v-if="continueCountdown > 0"> ({{ continueCountdown }})</template></template></button>
        <aside v-if="winEffectLab" class="win-effect-lab" aria-label="胡牌特效测试面板">
          <strong>胡牌特效测试</strong>
          <div v-for="(seat, index) in winEffectLabSeats" :key="seat">
            <span>{{ seat }}</span>
            <button :data-testid="`win-self-${index}`" @click="debugPreviewWin(index)">自摸</button>
            <button :data-testid="`win-rob-${index}`" @click="debugPreviewWin(index, { robbedKong: true })">抢杠胡</button>
          </div>
        </aside>
      </div>
    </div>
    <RulesPanel :open="rulesOpen" @close="rulesOpen = false" />
  </main>
</template>
