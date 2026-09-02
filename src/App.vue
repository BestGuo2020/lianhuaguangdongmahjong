<script setup lang="ts">
import { computed, defineAsyncComponent, ref, shallowRef, watch } from 'vue'
import StatsOverlay from './components/account/StatsOverlay.vue'
import WinEffectLab from './components/dev/WinEffectLab.vue'
import DisclaimerDialog from './components/legal/DisclaimerDialog.vue'
import GameShellHeader from './components/shell/GameShellHeader.vue'
import OrientationGate from './components/shell/OrientationGate.vue'
import GameTableHud from './components/table/GameTableHud.vue'
import LobbyView from './components/lobby/LobbyView.vue'
import LlmSettingsPanel from './components/llm/LlmSettingsPanel.vue'
import SettlementOverlay from './components/settlement/SettlementOverlay.vue'
import { useGame } from './game/variants/guangma/game'
import { useLotusGame } from './game/variants/lotus/lotusGame'
import { createLocalLlmControllers, createLotusLlmControllers } from './game/llm/runtime'
import type { LlmControllerStats } from './game/llm/llmController'
import { createActiveGamePort, type GameMode } from './game/core/contracts/activeGamePort'
import { useRemoteGame } from './game/online/useRemoteGame'
import { createRemoteLobbyController } from './game/online/orchestration/remoteLobbyController'
import { useDisclaimerGate } from './game/online/session/useDisclaimerGate'
import { useWakuDemoAuth } from './game/online/session/useWakuDemoAuth'
import { useRoomAvailability } from './game/online/session/useRoomAvailability'
import { useRemoteContinueCountdown } from './game/online/presentation/useRemoteContinueCountdown'
import { useAudio } from './game/core/presentation/useAudio'
import type { MatchType, TileType } from './game/core/contracts/types'
import { DEFAULT_RULE_VARIANT, type RuleVariant } from './game/core/rules/ruleVariants'
import type { TableThemeName } from './components/table/three/tableTheme'
import { resolveInitialTableTheme, shouldAutoUseLlmTheme } from './components/table/three/tableThemePreference'
import {
  animeCharacterAvatarUrl,
  readAnimeCharacterPreference,
  saveAnimeCharacterPreference,
} from './game/llm/animeCharacterPreference'
import type { CharacterId } from './game/llm/animeCharacters'
import { createAnimeFixedTtsExecutor } from './game/llm/animeFixedTtsExecutor'
import type { PlayerSeed } from './game/shared/runtime/localOpening'

// 规则面板只在首次打开时加载；牌桌的 Three.js 场景由 GameTableHud 延迟加载。
const RulesPanel = defineAsyncComponent(() => import('./components/RulesPanel.vue'))
const robotIconUrl = `${import.meta.env.BASE_URL}img/robot.svg`

const rulesOpen = ref(false)
const resultVisible = ref(true)
const selectedMatch = ref<MatchType>('east')
const selectedRule = ref<RuleVariant>(DEFAULT_RULE_VARIANT)
const gameTableReady = ref(false)
let tableReadyPromise: Promise<void> | null = null
let tableReadyResolve: (() => void) | null = null

function waitForTableReady() {
  if (gameTableReady.value) return Promise.resolve()
  if (!tableReadyPromise) {
    tableReadyPromise = new Promise<void>((resolve) => { tableReadyResolve = resolve })
  }
  return tableReadyPromise
}

function handleTableReady() {
  gameTableReady.value = true
  tableReadyResolve?.()
  tableReadyResolve = null
  tableReadyPromise = null
}

function resetTableReady() {
  gameTableReady.value = false
  // 解除已取消开局留下的等待，避免旧时间线永久挂起。
  tableReadyResolve?.()
  tableReadyResolve = null
  tableReadyPromise = null
}
const initialThemeCandidate = new URLSearchParams(window.location.search).get('theme')
const initialTableTheme = resolveInitialTableTheme(initialThemeCandidate)
const tableThemeName = ref<TableThemeName>(initialTableTheme.theme)
const explicitTableThemeSelected = ref(initialTableTheme.explicit)
const winEffectLab = import.meta.env.DEV && new URLSearchParams(window.location.search).has('winEffectLab')
const { playEffect, playEffectAndWait, playLlmAudio, startBgm } = useAudio()

const gameMode = ref<GameMode>('local')
// AI 大模型（单机人机座位 1-3）：仅大厅可配置；保存后立即装配到下一次开局。
const llmOpen = ref(false)
const llmMessages = ref<string[]>([])
/** 普通吐槽 4 秒消失；深思状态 persistent=true，直到结果返回/超时才清除或被结果台词替换。 */
const llmBubbles = ref<Record<number, { text: string; id: number; persistent?: boolean }>>({})
let llmBubbleSeq = 0
const llmHook = {
  onLlmMessage: (seat: number, text: string) => {
    llmMessages.value.push(text)
    if (llmMessages.value.length > 8) llmMessages.value.shift()
    const id = (llmBubbleSeq += 1)
    llmBubbles.value = { ...llmBubbles.value, [seat]: { text, id } }
    window.setTimeout(() => {
      if (llmBubbles.value[seat]?.id === id) {
        const next = { ...llmBubbles.value }
        delete next[seat]
        llmBubbles.value = next
      }
    }, 4000)
  },
  onLlmStatus: (seat: number, active: boolean, text = '让我想想怎么打。') => {
    if (active) {
      // 同一次流式思考复用节点，只直接替换当前安全进度内容。
      const id = llmBubbles.value[seat]?.persistent
        ? llmBubbles.value[seat].id
        : (llmBubbleSeq += 1)
      llmBubbles.value = { ...llmBubbles.value, [seat]: { text, id, persistent: true } }
      return
    }
    if (llmBubbles.value[seat]?.persistent) {
      const next = { ...llmBubbles.value }
      delete next[seat]
      llmBubbles.value = next
    }
  },
}
const createFixedTtsExecutor = () => createAnimeFixedTtsExecutor(undefined, {
  onLine: (event, request) => {
    if (request.kind === 'result') llmHook.onLlmMessage(event.seat, request.normalizedText)
  },
})
const localAnimeFixedTts = createFixedTtsExecutor()
const lotusAnimeFixedTts = createFixedTtsExecutor()
const remoteAnimeFixedTts = createFixedTtsExecutor()
watch(tableThemeName, (theme) => {
  if (theme === 'llmAnime') return
  localAnimeFixedTts.cancel()
  lotusAnimeFixedTts.cancel()
  remoteAnimeFixedTts.cancel()
})
const localLlm = shallowRef(createLocalLlmControllers(llmHook, {
  getThemeName: () => tableThemeName.value,
}))
const lotusLlm = shallowRef(createLotusLlmControllers(llmHook, {
  getThemeName: () => tableThemeName.value,
}))

function preferLlmTableTheme(llmEnabled: boolean) {
  if (shouldAutoUseLlmTheme(llmEnabled, explicitTableThemeSelected.value)) {
    tableThemeName.value = 'llm'
  }
}

// 本地配置在 setup 阶段同步读取；无 URL 明确主题时，首屏直接采用大模型专属主题。
preferLlmTableTheme(localLlm.value.enabled || lotusLlm.value.enabled)
// 引擎在 setup 阶段创建，保存配置时通过原地更新种子数组让下一次开局使用新的人设。
const localLlmSeeds = localLlm.value.seeds
const lotusLlmSeeds = lotusLlm.value.seeds
const animeCharacterId = ref<CharacterId>(readAnimeCharacterPreference())
const localHumanSeed: PlayerSeed = {
  name: '巅峰雀神',
  avatar: animeCharacterAvatarUrl(animeCharacterId.value),
  characterId: animeCharacterId.value,
  playerKind: 'human',
}
watch(animeCharacterId, (value) => {
  const saved = saveAnimeCharacterPreference(value)
  localHumanSeed.characterId = saved
  localHumanSeed.avatar = animeCharacterAvatarUrl(saved)
})
const llmStats = computed<LlmControllerStats>(() => ({
  requests: localLlm.value.stats.requests + lotusLlm.value.stats.requests,
  successes: localLlm.value.stats.successes + lotusLlm.value.stats.successes,
  fallbacks: localLlm.value.stats.fallbacks + lotusLlm.value.stats.fallbacks,
  messages: localLlm.value.stats.messages + lotusLlm.value.stats.messages,
  invalidActions: localLlm.value.stats.invalidActions + lotusLlm.value.stats.invalidActions,
  reasoningRequests: (localLlm.value.stats.reasoningRequests ?? 0) + (lotusLlm.value.stats.reasoningRequests ?? 0),
  thinkingRequests: (localLlm.value.stats.thinkingRequests ?? 0) + (lotusLlm.value.stats.thinkingRequests ?? 0),
  enhancedReasoningRequests: (localLlm.value.stats.enhancedReasoningRequests ?? 0) + (lotusLlm.value.stats.enhancedReasoningRequests ?? 0),
}))
const localGame = useGame({
  playSound: playEffect,
  playSoundAndWait: playEffectAndWait,
  // 单机对战取消回合倒计时：玩家无时限，不自动出牌/过牌
  countdownEnabled: false,
  aiControllers: localLlm.value.controllers ?? undefined,
  aiPlayerSeeds: localLlmSeeds,
  humanPlayerSeed: localHumanSeed,
  getThemeName: () => tableThemeName.value,
  animeFixedTts: localAnimeFixedTts,
})
const lotusGame = useLotusGame({
  playSound: playEffect,
  playSoundAndWait: playEffectAndWait,
  countdownEnabled: false,
  aiControllers: lotusLlm.value.controllers ?? undefined,
  aiPlayerSeeds: lotusLlmSeeds,
  humanPlayerSeed: localHumanSeed,
  getThemeName: () => tableThemeName.value,
  animeFixedTts: lotusAnimeFixedTts,
})
const remoteGame = useRemoteGame({
  playSound: playEffect,
  playSoundAndWait: playEffectAndWait,
  waitForTableReady,
  onLlmMessage: llmHook.onLlmMessage,
  onLlmStatus: llmHook.onLlmStatus,
  getCharacterId: () => animeCharacterId.value,
  getThemeName: () => tableThemeName.value,
  animeFixedTts: remoteAnimeFixedTts,
  playLlmAudio,
})

// 莲花麻将旧版翻精规则同时支持本地与联机对战。
const singlePlayerOnly = computed(() => false)
const usesLotusLocalEngine = computed(() => selectedRule.value === 'lotus-legacy')
watch(() => remoteGame.rulesetId.value, (value) => {
  if (value === 'lotus-classic' || value === 'lotus-legacy') selectedRule.value = value
})

// 类型安全的模式桥：共享状态与动作由 GamePort 显式约束，调试/房间扩展能力不混入 UI 契约。
// local 槽按所选玩法解析到「莲花广麻」或「莲花麻将」本地引擎。
const game = createActiveGamePort(
  gameMode,
  () => usesLotusLocalEngine.value ? lotusGame : localGame,
  remoteGame,
)

const {
  phase, players, wall, wallHeadDrawn, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
  actionPrompt, announcement, tableActionEvent, scoreFlowEvent, result, winEffect, winPresentation, revealHands, winningPlayerIndex,
  round, dealer, user, isUserTurn, userCanHu,
  matchName, matchFinished, honba, roundLabel, standings,
  userKongs, capabilities, userCurrentWaits, userTingOptions, userDiscardWaits, dealAnimation, openingStage, diceValues, diceThrowerIndex, startGame, selectTile, clearUserSelection, userDiscard, userPass, userPeng, userGangFromDiscard,
  userGang, userHu, nextRound, returnToLobby,
} = game

// 莲花麻将专属：翻精指示牌 / 癞子集合 / 3D 牌山断点（仅本地莲花麻将模式有意义）。
const lotusTable = computed(() => capabilities.value.lotusTable)
const userHasWindKong = computed(() => capabilities.value.windKong?.available ?? false)
const userChi = (optionIndex: number) => capabilities.value.chi?.choose(optionIndex)
const userWindKong = () => capabilities.value.windKong?.execute()
const flipTile = computed(() => lotusTable.value?.flipTile ?? null)
// 广麻固定以白板为癞子；莲花麻将将精牌与白板替代能力分开传给界面。
// 联机 lotus-classic 快照不下发精牌（jokerTiles 为空数组），需兜底为白板癞子，
// 否则多人模式下白板无「癞」标记。莲花麻将（lotus-legacy）的精牌由快照下发，不受影响。
const jokerTiles = computed<TileType[]>(() => {
  const jokers = lotusTable.value?.jokerTiles
  return jokers && jokers.length ? jokers : ['white']
})
const wildcardTiles = computed<TileType[]>(() => lotusTable.value?.wildcardTiles ?? [])
const wallBreakIndex = computed(() => lotusTable.value?.wallBreakIndex)
const flipStack = computed(() => lotusTable.value?.flipStack ?? undefined)
const remoteRulesetId = computed(() => remoteGame.rulesetId.value)
const remoteSecondDice = computed(() => remoteGame.secondDice.value)
// 单机莲花麻将第二次掷骰（二骰）；掷出前为 null，不显示角标。
const lotusSecondDice = computed<[number, number] | undefined>(() => lotusGame.secondDice.value ?? undefined)

// 开发期杠测试入口：仅本地模式注入状态（联机由服务端权威，不适用）；仅对莲花广麻生效。
const debugKong = (mode: 'concealed' | 'added' | 'both') => {
  if (gameMode.value !== 'local' || singlePlayerOnly.value) return
  localGame.debugPreviewKong(mode)
}
const debugFourRed = () => {
  if (gameMode.value !== 'local' || singlePlayerOnly.value) return
  localGame.debugPreviewFourRed()
}
const debugPreviewWin = (winnerIndex = 0, options: { robbedKong?: boolean } = {}) => {
  if (gameMode.value !== 'local' || singlePlayerOnly.value) return
  localGame.debugPreviewWin(winnerIndex, options)
}

// ── 联机模式状态（远程房间 / WS 连接）──────────────────
const {
  sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, playerId, isCreator, roomSeats, roomTimeLimit, remoteActions, waitingNextRound, storedSession, signalQuality,
  llmEnabled, effectiveLlmEnabled, llmAvailable,
  autoPlay: remoteAutoPlay, toggleAutoPlay,
} = remoteGame

// 联机：加入房间后，本家角色变化同步到服务器座位（开局前生效）。
watch(animeCharacterId, (value) => {
  if (gameMode.value === 'remote' && roomId.value && mySeat.value >= 0) {
    void remoteActions.updateCharacter(value).catch(() => {})
  }
})

// 联机房间的大模型能力可能在恢复会话或房间元数据返回后才生效。
watch(effectiveLlmEnabled, (enabled) => preferLlmTableTheme(enabled), { immediate: true })

const { roomMeta } = useRoomAvailability(gameMode, roomId)

const disclaimerGate = useDisclaimerGate(playerId)
const wakuAuth = useWakuDemoAuth()

function startGameWithAudio() {
  llmOpen.value = false
  resetTableReady()
  startBgm()
  // 音效在后台缓存，不能阻塞玩家创建和 3D 牌桌首次渲染。
  startGame(selectedMatch.value, { waitForTableReady })
}

const lobbyController = createRemoteLobbyController({
  gameMode,
  selectedMatch,
  selectedRule,
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

watch(() => wakuAuth.account.value?.displayName, (displayName) => {
  if (displayName && !nicknameInput.value.trim()) nicknameInput.value = displayName.slice(0, 12)
}, { immediate: true })

const statsOpen = ref(false)
const showLobby = computed(() => (
  phase.value === 'lobby'
  || (gameMode.value === 'remote' && Boolean(roomId.value) && players.value.length === 0)
))
watch(showLobby, (value) => {
  if (value) resetTableReady()
  else llmOpen.value = false
}, { immediate: true })

function applyLlmSettings() {
  // 保存事件只会在大厅触发；运行中的对局不会被切换模型打断。
  if (!showLobby.value || gameMode.value !== 'local') return

  const nextLocalLlm = createLocalLlmControllers(llmHook, {
    getThemeName: () => tableThemeName.value,
  })
  localGame.replaceAiControllers(nextLocalLlm.controllers)
  localLlmSeeds.splice(0, localLlmSeeds.length, ...nextLocalLlm.seeds)
  nextLocalLlm.seeds = localLlmSeeds
  localLlm.value = nextLocalLlm

  const nextLotusLlm = createLotusLlmControllers(llmHook, {
    getThemeName: () => tableThemeName.value,
  })
  lotusGame.replaceAiControllers(nextLotusLlm.controllers)
  lotusLlmSeeds.splice(0, lotusLlmSeeds.length, ...nextLotusLlm.seeds)
  nextLotusLlm.seeds = lotusLlmSeeds
  lotusLlm.value = nextLotusLlm

  preferLlmTableTheme(nextLocalLlm.enabled || nextLotusLlm.enabled)
}
// 真人座位集合（用于结算页举报按钮）：本地模式仅本家（seat 0）为真人；
// 远程模式以 REST 加入占座的座位为准（AI 补位不在 roomSeats 中）。
const humanSeats = computed(() => (
  gameMode.value === 'remote'
    ? roomSeats.value.filter(Boolean).map((seat) => seat.seat)
    : [0]
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

function changeTableTheme(theme: TableThemeName) {
  tableThemeName.value = theme
  remoteGame.updatePresentationAudioMode()
  explicitTableThemeSelected.value = true
  const url = new URL(window.location.href)
  // 手动选择（包括墨玉）始终写入 URL，确保 LLM 开启时刷新后仍尊重用户覆盖。
  url.searchParams.set('theme', theme)
  window.history.replaceState(window.history.state, '', url)
}

</script>

<template>
  <OrientationGate />
  <main class="game-app" :class="{ 'is-lobby': showLobby }" :data-table-theme="tableThemeName">
    <div v-if="gameMode === 'remote' && wsStatus === 'reconnecting'" class="remote-banner" role="status">网络断开，正在重连…</div>
    <div v-else-if="gameMode === 'remote' && wsStatus === 'closed' && roomId" class="remote-banner error" role="status">连接已断开，正在尝试恢复…</div>
    <div v-if="gameMode === 'remote' && waitingNextRound" class="remote-banner" role="status">已确认，等待其他玩家…</div>
    <div class="" :class="{ 'has-three-scene': players.length }">
      <GameShellHeader
        :game-mode="gameMode"
        :phase="showLobby ? 'lobby' : phase"
        :has-players="Boolean(players.length)"
        :match-name="matchName"
        :round-label="roundLabel"
        :honba="honba"
        :room-id="roomId"
        :signal-quality="signalQuality"
        :signal-warning-threshold="1"
        :theme-name="tableThemeName"
        @quit="quitMatch"
        @open-rules="rulesOpen = true"
        @change-theme="changeTableTheme"
      />

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
        :match-finished="matchFinished"
        :winning-player-index="winningPlayerIndex"
        :dealer="dealer"
        :is-user-turn="isUserTurn"
        :user-can-hu="userCanHu"
        :match-name="matchName"
        :round-label="roundLabel"
        :deal-animation="dealAnimation"
        :opening-stage="openingStage"
        :dice-values="diceValues"
        :dice-thrower-index="diceThrowerIndex"
        :user-current-waits="userCurrentWaits"
        :user-ting-options="userTingOptions"
        :user-discard-waits="userDiscardWaits"
        :user-kongs="userKongs"
        :user-has-wind-kong="userHasWindKong"
        :auto-play-enabled="gameMode === 'remote'"
        :auto-play="remoteAutoPlay"
        :llm-bubbles="llmBubbles"
        :joker-tiles="jokerTiles"
        :wildcard-tiles="wildcardTiles"
        :theme-name="tableThemeName"
        :ruleset-id="gameMode === 'remote' ? remoteRulesetId : selectedRule"
        :second-dice="gameMode === 'remote' ? remoteSecondDice : (usesLotusLocalEngine ? lotusSecondDice : undefined)"
        :flip-tile="flipTile"
        :wall-break-index="wallBreakIndex"
        :flip-stack="flipStack"
        @select-tile="selectTile"
        @clear-selection="clearUserSelection"
        @discard="userDiscard"
        @pass="userPass"
        @peng="userPeng"
        @chi="userChi"
        @gang-from-discard="userGangFromDiscard"
        @gang="userGang"
        @hu="userHu"
        @wind-kong="userWindKong"
        @toggle-auto-play="toggleAutoPlay"
        @ready="handleTableReady"
      />

      <LobbyView
        v-if="showLobby"
        v-model:game-mode="gameMode"
        v-model:selected-match="selectedMatch"
        v-model:selected-rule="selectedRule"
        v-model:nickname-input="nicknameInput"
        v-model:join-code="joinCode"
        v-model:anime-character-id="animeCharacterId"
        :table-theme-name="tableThemeName"
        :stored-session="storedSession"
        :room-id="roomId"
        :match-name="matchName"
        :room-meta="roomMeta"
        :session-status="sessionStatus"
        :session-error="sessionError"
        :room-time-limit="roomTimeLimit"
        :room-seats="roomSeats"
        :llm-enabled="llmEnabled"
        :effective-llm-enabled="effectiveLlmEnabled"
        :llm-available="llmAvailable"
        :llm-providers="roomMeta?.llmProviders ?? []"
        :my-seat="mySeat"
        :is-creator="isCreator"
        :single-player-only="singlePlayerOnly"
        :all-occupied-ready="allOccupiedReady"
        :match-starting="matchStarting"
        :copied="copied"
        :leaving="leaving"
        :closing="closing"
        :waku-authenticated="wakuAuth.authenticated.value"
        :waku-account-name="wakuAuth.account.value?.displayName ?? ''"
        :waku-auth-loading="wakuAuth.loading.value"
        :waku-auth-error="wakuAuth.error.value"
        @start-local="startGameWithAudio"
        @create-room="(payload: { llmEnabled: boolean }) => createRemoteRoom(payload.llmEnabled)"
        @join-room="joinRemoteRoom"
        @resume-session="resumeRemoteSession"
        @copy-room="copyRoomCode"
        @toggle-ready="toggleReady"
        @start-remote="(payload: { llmSeats?: Array<{ seat: number; providerId: string }> }) => startRemoteMatch(payload?.llmSeats)"
        @leave-room="leaveRoom"
        @close-room="closeRoom"
        @open-stats="statsOpen = true"
        @open-rules="rulesOpen = true"
        @waku-login="wakuAuth.login"
        @waku-logout="wakuAuth.logout"
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
        :human-seats="humanSeats"
        :joker-tiles="jokerTiles"
        :wildcard-tiles="wildcardTiles"
        :theme-name="tableThemeName"
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
    <RulesPanel :open="rulesOpen" :variant="selectedRule" @close="rulesOpen = false" />
    <button
      v-if="gameMode === 'local' && showLobby"
      class="llm-fab"
      aria-label="AI 设置"
      title="AI 大模型设置（联机由服务端提供商配置）"
      data-testid="llm-fab"
      @click="llmOpen = true"
    ><img :src="robotIconUrl" alt="" aria-hidden="true"></button>
    <LlmSettingsPanel
      :open="llmOpen && showLobby"
      :messages="llmMessages"
      :stats="llmStats"
      @close="llmOpen = false"
      @saved="applyLlmSettings"
    />
  </main>
</template>
