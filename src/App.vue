<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import GameTableHud from './components/table/GameTableHud.vue'
import LobbyView from './components/lobby/LobbyView.vue'
import SettlementOverlay from './components/settlement/SettlementOverlay.vue'
import { DISCLAIMER_SECTIONS, DISCLAIMER_TITLE, DISCLAIMER_VERSION } from './content/disclaimer'
import { BASE_SCORE } from './game/core/rules'
import { useGame } from './game/core/useGame'
import { createActiveGamePort, type GameMode } from './game/core/activeGamePort'
import { useRemoteGame } from './game/online/useRemoteGame'
import { agreeDisclaimer, getDisclaimerAgreement, getPlayerStats, getPlayerStatsById } from './game/online/api/accountApi'
import type { PlayerStats } from './game/online/api/accountApi'
import { reportPlayer as reportPlayerApi } from './game/online/api/moderationApi'
import { getRoomMeta, type RoomMeta } from './game/online/api/roomApi'
import { useAudio } from './game/core/useAudio'
import type { MatchType } from './game/core/types'

// 规则面板只在首次打开时加载；牌桌的 Three.js 场景由 GameTableHud 延迟加载。
const RulesPanel = defineAsyncComponent(() => import('./components/RulesPanel.vue'))

const rulesOpen = ref(false)
const resultVisible = ref(true)
const selectedMatch = ref<MatchType>('east')
const imageBase = `${import.meta.env.BASE_URL}img/`
const winEffectLab = import.meta.env.DEV && new URLSearchParams(window.location.search).has('winEffectLab')
const winEffectLabSeats = ['本家', '下家', '对家', '上家']
const requiresLandscape = ref(false)
const orientationMessage = ref('')
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

const gameMode = ref<GameMode>('local')
const localGame = useGame({ playSound: playEffect, playSoundAndWait: playEffectAndWait })
const remoteGame = useRemoteGame({ playSound: playEffect, playSoundAndWait: playEffectAndWait })

// 类型安全的模式桥：共享状态与动作由 GamePort 显式约束，调试/房间扩展能力不混入 UI 契约。
const game = createActiveGamePort(gameMode, localGame, remoteGame)

const {
  phase, players, wall, wallHeadDrawn, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
  actionPrompt, announcement, tableActionEvent, scoreFlowEvent, result, winEffect, winPresentation, revealHands, winningPlayerIndex,
  round, dealer, user, isUserTurn, userCanHu,
  matchName, matchFinished, honba, roundLabel, standings,
  userKongs, userCurrentWaits, userTingOptions, userDiscardWaits, dealAnimation, openingStage, diceValues, startGame, selectTile, clearUserSelection, userDiscard, userPass, userPeng, userGangFromDiscard,
  userGang, userHu, nextRound, returnToLobby,
} = game

// 开发期杠测试入口：仅本地模式注入状态（联机由服务端权威，不适用）
const debugKong = (mode: 'concealed' | 'added' | 'both') => {
  if (gameMode.value !== 'local') return
  localGame.debugPreviewKong(mode)
}
const debugFourRed = () => {
  if (gameMode.value !== 'local') return
  localGame.debugPreviewFourRed()
}
const debugPreviewWin = (winnerIndex = 0, options: { robbedKong?: boolean } = {}) => {
  if (gameMode.value !== 'local') return
  localGame.debugPreviewWin(winnerIndex, options)
}

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

watch(result, (value) => {
  resultVisible.value = Boolean(value)
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
      <div class="felt-table" :class="{ 'has-three-scene': players.length }">
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

        <GameTableHud
          v-if="players.length && user"
          :players="players"
          :user="user"
          :phase="phase"
          :wall="wall"
          :wall-head-drawn="wallHeadDrawn"
          :wall-count="wallCount"
          :current-player="currentPlayer"
          :selected-index="selectedIndex"
          :turn-seconds="turnSeconds"
          :last-discard="lastDiscard"
          :action-prompt="actionPrompt"
          :announcement="announcement"
          :table-action-event="tableActionEvent"
          :score-flow-event="scoreFlowEvent"
          :result="result"
          :win-effect="winEffect"
          :win-presentation="winPresentation"
          :reveal-hands="revealHands"
          :winning-player-index="winningPlayerIndex"
          :dealer="dealer"
          :is-user-turn="isUserTurn"
          :user-can-hu="userCanHu"
          :match-name="matchName"
          :round-label="roundLabel"
          :deal-animation="dealAnimation"
          :opening-stage="openingStage"
          :dice-values="diceValues"
          :user-current-waits="userCurrentWaits"
          :user-ting-options="userTingOptions"
          :user-discard-waits="userDiscardWaits"
          :user-kongs="userKongs"
          @select-tile="selectTile"
          @clear-selection="clearUserSelection"
          @discard="userDiscard"
          @pass="userPass"
          @peng="userPeng"
          @gang-from-discard="userGangFromDiscard"
          @gang="userGang"
          @hu="userHu"
        />

        <LobbyView
          v-if="phase === 'lobby'"
          v-model:game-mode="gameMode"
          v-model:selected-match="selectedMatch"
          v-model:nickname-input="nicknameInput"
          v-model:join-code="joinCode"
          :stored-session="storedSession"
          :room-id="roomId"
          :room-meta="roomMeta"
          :session-status="sessionStatus"
          :session-error="sessionError"
          :room-time-limit="roomTimeLimit"
          :room-seats="roomSeats"
          :my-seat="mySeat"
          :is-creator="isCreator"
          :all-occupied-ready="allOccupiedReady"
          :match-starting="matchStarting"
          :copied="copied"
          :leaving="leaving"
          :closing="closing"
          @start-local="startGameWithAudio"
          @create-room="createRemoteRoom"
          @join-room="joinRemoteRoom"
          @resume-session="resumeRemoteSession"
          @copy-room="copyRoomCode"
          @toggle-ready="remoteActions.toggleReady()"
          @start-remote="startRemoteMatch"
          @leave-room="leaveRoom"
          @close-room="closeRoom"
          @open-stats="openStats"
          @open-rules="rulesOpen = true"
        />

        <SettlementOverlay
          v-model:result-visible="resultVisible"
          :result="result"
          :match-finished="matchFinished"
          :dealer="dealer"
          :waiting-next-round="waitingNextRound"
          :game-mode="gameMode"
          :continue-countdown="continueCountdown"
          :match-name="matchName"
          :standings="standings"
          :player-id="playerId"
          @next-round="nextRound"
          @return-to-lobby="returnToLobby"
          @report="reportPlayer"
        />
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
        <aside v-if="winEffectLab" class="win-effect-lab" aria-label="胡牌特效测试面板">
          <strong>胡牌特效测试</strong>
          <div v-for="(seat, index) in winEffectLabSeats" :key="seat">
            <span>{{ seat }}</span>
            <button :data-testid="`win-self-${index}`" @click="debugPreviewWin(index)">自摸</button>
            <button :data-testid="`win-rob-${index}`" @click="debugPreviewWin(index, { robbedKong: true })">抢杠胡</button>
          </div>
          <strong>杠选牌测试</strong>
          <div class="kong-debug">
            <span>本家</span>
            <button data-testid="kong-concealed" @click="debugKong('concealed')">暗杠</button>
            <button data-testid="kong-added" @click="debugKong('added')">补杠</button>
            <button data-testid="kong-both" @click="debugKong('both')">双杠</button>
          </div>
          <strong>红中测试</strong>
          <div class="kong-debug">
            <span>本家</span>
            <button data-testid="four-red" @click="debugFourRed">四红中</button>
          </div>
        </aside>
      </div>
    </div>
    <RulesPanel :open="rulesOpen" @close="rulesOpen = false" />
  </main>
</template>
