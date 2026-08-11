<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import StatsOverlay from './components/account/StatsOverlay.vue'
import DisclaimerDialog from './components/legal/DisclaimerDialog.vue'
import OrientationGate from './components/shell/OrientationGate.vue'
import GameTableHud from './components/table/GameTableHud.vue'
import LobbyView from './components/lobby/LobbyView.vue'
import SettlementOverlay from './components/settlement/SettlementOverlay.vue'
import { BASE_SCORE } from './game/core/rules'
import { useGame } from './game/core/useGame'
import { createActiveGamePort, type GameMode } from './game/core/activeGamePort'
import { useRemoteGame } from './game/online/useRemoteGame'
import { createRemoteLobbyController } from './game/online/orchestration/remoteLobbyController'
import { useDisclaimerGate } from './game/online/session/useDisclaimerGate'
import { useRoomAvailability } from './game/online/session/useRoomAvailability'
import { useRemoteContinueCountdown } from './game/online/presentation/useRemoteContinueCountdown'
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
const { soundOn, playEffect, playEffectAndWait, startBgm } = useAudio()

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
// 网络信号：0-3 格的语义是「连接健康度」，而非延迟（棋牌类对延迟不敏感）
const signalText = computed(() =>
  ({ 0: '网络不稳定', 1: '网络波动', 2: '网络良好', 3: '网络流畅' })[signalQuality.value] ?? '')

const { roomMeta } = useRoomAvailability(gameMode, roomId)

const disclaimerGate = useDisclaimerGate(playerId)

function startGameWithAudio() {
  startBgm()
  // 音效在后台缓存，不能阻塞玩家创建和 3D 牌桌首次渲染。
  startGame(selectedMatch.value)
}

const lobbyController = createRemoteLobbyController({
  gameMode,
  selectedMatch,
  phase,
  roomId,
  nickname,
  playerId,
  roomSeats,
  actions: remoteActions,
  guardEntry: disclaimerGate.guard,
  startBgm,
})
const {
  nicknameInput, joinCode, allOccupiedReady, copied, matchStarting, leaving, closing,
  createRoom: createRemoteRoom,
  joinRoom: joinRemoteRoom,
  resumeSession: resumeRemoteSession,
  copyRoomCode,
  startMatch: startRemoteMatch,
  quitMatch,
  leaveRoom,
  closeRoom,
  report: reportPlayer,
  toggleReady,
} = lobbyController

const statsOpen = ref(false)

watch(result, (value) => {
  resultVisible.value = Boolean(value)
})

const continueCountdown = useRemoteContinueCountdown({
  gameMode,
  phase,
  result,
  matchFinished,
  waitingNextRound,
  continueRound: nextRound,
})

</script>

<template>
  <OrientationGate />
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
          @toggle-ready="toggleReady"
          @start-remote="startRemoteMatch"
          @leave-room="leaveRoom"
          @close-room="closeRoom"
          @open-stats="statsOpen = true"
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
        <StatsOverlay
          v-model:open="statsOpen"
          :player-id="playerId"
          :nickname="nickname"
          :fallback-nickname="nicknameInput"
        />
        <DisclaimerDialog
          :open="disclaimerGate.open.value"
          @accept="disclaimerGate.accept"
          @decline="disclaimerGate.decline"
        />
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
