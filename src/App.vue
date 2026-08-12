<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import StatsOverlay from './components/account/StatsOverlay.vue'
import WinEffectLab from './components/dev/WinEffectLab.vue'
import DisclaimerDialog from './components/legal/DisclaimerDialog.vue'
import GameShellHeader from './components/shell/GameShellHeader.vue'
import OrientationGate from './components/shell/OrientationGate.vue'
import GameTableHud from './components/table/GameTableHud.vue'
import LobbyView from './components/lobby/LobbyView.vue'
import SettlementOverlay from './components/settlement/SettlementOverlay.vue'
import { useGame } from './game/core/local/useGame'
import { createActiveGamePort, type GameMode } from './game/core/contracts/activeGamePort'
import { useRemoteGame } from './game/online/useRemoteGame'
import { createRemoteLobbyController } from './game/online/orchestration/remoteLobbyController'
import { useDisclaimerGate } from './game/online/session/useDisclaimerGate'
import { useRoomAvailability } from './game/online/session/useRoomAvailability'
import { useRemoteContinueCountdown } from './game/online/presentation/useRemoteContinueCountdown'
import { useAudio } from './game/core/presentation/useAudio'
import type { MatchType } from './game/core/contracts/types'
import { DEFAULT_RULE_VARIANT, type RuleVariant } from './game/core/rules/ruleVariants'

// 规则面板只在首次打开时加载；牌桌的 Three.js 场景由 GameTableHud 延迟加载。
const RulesPanel = defineAsyncComponent(() => import('./components/RulesPanel.vue'))

const rulesOpen = ref(false)
const resultVisible = ref(true)
const selectedMatch = ref<MatchType>('east')
const selectedRule = ref<RuleVariant>(DEFAULT_RULE_VARIANT)
const winEffectLab = import.meta.env.DEV && new URLSearchParams(window.location.search).has('winEffectLab')
const { soundOn, playEffect, playEffectAndWait, startBgm } = useAudio()

const gameMode = ref<GameMode>('local')
const localGame = useGame({
  playSound: playEffect,
  playSoundAndWait: playEffectAndWait,
  // 单机对战取消回合倒计时：玩家无时限，不自动出牌/过牌
  countdownEnabled: false,
})
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
  sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, playerId, isCreator, roomSeats, roomTimeLimit, remoteActions, waitingNextRound, storedSession, signalQuality,
} = remoteGame

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
const showLobby = computed(() => (
  phase.value === 'lobby'
  || (gameMode.value === 'remote' && Boolean(roomId.value) && players.value.length === 0)
))

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
        <GameShellHeader
          :game-mode="gameMode"
          :phase="showLobby ? 'lobby' : phase"
          :has-players="Boolean(players.length)"
          :match-name="matchName"
          :round-label="roundLabel"
          :honba="honba"
          :room-id="roomId"
          :signal-quality="signalQuality"
          :sound-on="soundOn"
          @quit="quitMatch"
          @toggle-sound="soundOn = !soundOn"
          @open-rules="rulesOpen = true"
        />
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
          v-if="showLobby"
          v-model:game-mode="gameMode"
          v-model:selected-match="selectedMatch"
          v-model:selected-rule="selectedRule"
          v-model:nickname-input="nicknameInput"
          v-model:join-code="joinCode"
          :stored-session="storedSession"
          :room-id="roomId"
          :match-name="matchName"
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
        <WinEffectLab
          :open="winEffectLab"
          @preview-win="debugPreviewWin"
          @preview-kong="debugKong"
          @preview-four-red="debugFourRed"
        />
      </div>
    </div>
    <RulesPanel :open="rulesOpen" @close="rulesOpen = false" />
  </main>
</template>
