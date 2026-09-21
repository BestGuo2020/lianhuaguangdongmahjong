<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import StatsOverlay from './components/account/StatsOverlay.vue'
import WinEffectLab from './components/dev/WinEffectLab.vue'
import DisclaimerDialog from './components/legal/DisclaimerDialog.vue'
import GameShellHeader from './components/shell/GameShellHeader.vue'
import OrientationGate from './components/shell/OrientationGate.vue'
import GameTableHud from './components/table/GameTableHud.vue'
import LobbyView from './components/lobby/LobbyView.vue'
import LlmSettingsPanel from './components/llm/LlmSettingsPanel.vue'
import SettlementOverlay from './components/settlement/SettlementOverlay.vue'
import ReplayListView from './components/replay/ReplayListView.vue'
import { useGame } from './game/variants/guangma/game'
import { useLotusGame } from './game/variants/lotus/lotusGame'
import { useBloodFlowGame } from './game/variants/lotus/bloodFlow/useBloodFlowGame'
import { useBloodFlowRemoteGame } from './game/variants/lotus/bloodFlow/useBloodFlowRemoteGame'
import { bloodFlowEnabled } from './game/variants/lotus/bloodFlow/availability'
import { BLOOD_FLOW_CONFIG } from './game/variants/lotus/bloodFlow/config'
import { createLocalLlmControllers, createLotusLlmControllers } from './game/llm/runtime'
import type { LlmControllerStats } from './game/llm/llmController'
import { createActiveGamePort, type GameMode } from './game/core/contracts/activeGamePort'
import type { GamePort } from './game/core/contracts/gamePort'
import { useRemoteGame } from './game/online/useRemoteGame'
import type { StoredSession } from './game/online/session/remoteSessionStore'
import { getRoom, type LlmSeatRequest, type ServerLlmStyle } from './game/online/api/roomApi'
import type { RoomMatchInfo, RoomSyncSnapshot } from './game/online/session/roomSyncState'
import { createRemoteLobbyController } from './game/online/orchestration/remoteLobbyController'
import { useDisclaimerGate } from './game/online/session/useDisclaimerGate'
import { useWakuDemoAuth } from './game/online/session/useWakuDemoAuth'
import { useRoomAvailability } from './game/online/session/useRoomAvailability'
import { useRemoteContinueCountdown } from './game/online/presentation/useRemoteContinueCountdown'
import { useAudio } from './game/core/presentation/useAudio'
import type { MatchType, TileType } from './game/core/contracts/types'
import { DEFAULT_RULE_VARIANT, getRuleVariant, type RuleVariant } from './game/core/rules/ruleVariants'
import type { TableThemeName } from './components/table/three/tableTheme'
import {
  readTableThemePreference,
  resolveInitialTableTheme,
  shouldAutoUseLlmTheme,
} from './components/table/three/tableThemePreference'
import {
  themePresentationByName,
  themePresentationCssVariables,
} from './theme/themePresentation'
import {
  readAnimeCharacterPreference,
  saveAnimeCharacterPreference,
} from './game/llm/animeCharacterPreference'
import type { CharacterId } from './game/llm/animeCharacters'
import { createAnimeFixedTtsExecutor } from './game/llm/animeFixedTtsExecutor'
import { defaultAvatarForSeat } from './game/core/presentation/avatar'
import { preloadAnimeCharacterAssets } from './game/core/presentation/llmAnimeAssets'
import type { PlayerSeed } from './game/shared/runtime/localOpening'
import { useReplayRecorder } from './game/replay/useReplayRecorder'
import { createAnalysisStorage } from './game/replay/analysis/storage'
import { createAnalysisSession, reconcileAnalysisWithReplay } from './game/replay/analysis/session'
import type { AnalysisSeatControl } from './game/replay/analysis/types'
import { BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI } from './game/variants/lotus/bloodFlow/config'
import type { ReplayMatch, ReplayRound } from './game/replay/types'

// 规则面板只在首次打开时加载；牌桌的 Three.js 场景由 GameTableHud 延迟加载。
const RulesPanel = defineAsyncComponent(() => import('./components/RulesPanel.vue'))
// 回放视图会拉起 3D 牌桌，按需加载。
const ReplayViewer = defineAsyncComponent(() => import('./components/replay/ReplayViewer.vue'))
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
const initialTableTheme = resolveInitialTableTheme(initialThemeCandidate, readTableThemePreference())
const tableThemeName = ref<TableThemeName>(initialTableTheme.theme)
const explicitTableThemeSelected = ref(initialTableTheme.explicit)
const themePresentation = computed(() => themePresentationByName(tableThemeName.value))
const themePresentationStyle = computed(() => themePresentationCssVariables(themePresentation.value))
if (initialThemeCandidate !== null && initialThemeCandidate !== initialTableTheme.theme) {
  const canonicalUrl = new URL(window.location.href)
  canonicalUrl.searchParams.set('theme', initialTableTheme.theme)
  window.history.replaceState(window.history.state, '', canonicalUrl)
}
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
  // 二次元主题：角色头像与鸣牌/胡牌立绘在开局前预热，避免首次出现时闪烁/延迟；
  // immediate 让 `?theme=llmAnime` 直接进入（或恢复上次主题）也预取。
  if (theme === 'llmAnime') {
    void preloadAnimeCharacterAssets()
    return
  }
  localAnimeFixedTts.cancel()
  lotusAnimeFixedTts.cancel()
  remoteAnimeFixedTts.cancel()
}, { immediate: true })
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
// 本家头像始终是本地默认头像；二次元主题的角色头像只由 `llmAnime` 的表现层覆盖
// （GameTableHud / SettlementOverlay / BloodFlowResultPlayers 按主题选择），
// 这样非 llmAnime 主题不会显示二次元角色头像，主题热切换也不需要重开一局。
const localHumanSeed: PlayerSeed = {
  name: '巅峰雀神',
  avatar: defaultAvatarForSeat(0),
  characterId: animeCharacterId.value,
  playerKind: 'human',
}
watch(animeCharacterId, (value) => {
  // 角色形象只改 characterId（动作/语音/llmAnime 头像的来源），不改权威 avatar。
  localHumanSeed.characterId = saveAnimeCharacterPreference(value)
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
// ── 对局回放（只存本机 IndexedDB，不上服务器）──
// 录制器在三个单机引擎之间共享：同一时刻只有所选玩法的引擎在跑，局序不会交错。
// ── AI 分析记录（方案 docs/blood-flow/design/replay-ai-analysis-recording.md）──
// 独立分析区（自己的数据库与失败域，§9.2/§9.5）；**默认关闭**，玩家在「对局回放」里用开关打开。
// 开关只影响分析录制，不改变任何策略动作或对局结果（§10.1、§10.7）。
const analysisStorage = createAnalysisStorage()
const analysisEnabled = ref(import.meta.env.DEV
  ? localStorage.getItem('lgm_analysis_enabled') !== '0'
  : localStorage.getItem('lgm_analysis_enabled') === '1')
/** 开关落盘：持久化失败（隐私模式）也只在本次会话生效，不影响任何对局行为。 */
function setAnalysisEnabled(next: boolean) {
  analysisEnabled.value = next
  try { localStorage.setItem('lgm_analysis_enabled', next ? '1' : '0') } catch { /* 隐私模式：本次会话内生效 */ }
}
const analysis = createAnalysisSession({
  // 传取值函数：开关随时可切，**下一场生效**（不需要刷新页面）
  enabled: () => analysisEnabled.value,
  storage: analysisStorage,
  onError: (detail) => console.warn('[analysis]', detail),
})

const replay = useReplayRecorder({
  meta: () => ({
    rulesetId: selectedRule.value,
    rulesetName: getRuleVariant(selectedRule.value).name,
    themeName: tableThemeName.value,
    humanSeat: 0,
    // 本场是否开着分析录制：列表据此区分「分析：未开启」与「分析：缺少决策分析记录」（§10.7）
    analysisRecorded: analysis.active(),
  }),
})

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
  recorder: replay.hooks,
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
  recorder: replay.hooks,
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

const bloodFlowGame = useBloodFlowGame({ playSound: playEffect, playSoundAndWait: playEffectAndWait,
  countdownEnabled: false,
  getThemeName: () => tableThemeName.value, animeFixedTts: lotusAnimeFixedTts,
  humanPlayerSeed: localHumanSeed, aiPlayerSeeds: lotusLlmSeeds, recorder: replay.hooks,
  // AI 分析记录：引擎拿到的是一个稳定代理（换场只换内部录制器）；关闭时为 null，零成本。
  analysis: analysis.port })
const bloodFlowRemoteGame = useBloodFlowRemoteGame({ playSound: playEffect,
  playSoundAndWait: playEffectAndWait, playLlmAudio,
  getCharacterId: () => animeCharacterId.value,
  getThemeName: () => tableThemeName.value, animeFixedTts: lotusAnimeFixedTts })
// 联机槽按玩法切换：血流走血流 WS 权威，其余走经典联机协议。
const activeRemote = computed(() => (
  gameMode.value === 'remote' && selectedRule.value === 'lotus-blood-flow'
    ? bloodFlowRemoteGame
    : remoteGame
))

// 莲花麻将旧版翻精规则同时支持本地与联机对战。
const singlePlayerOnly = computed(() => false)
const usesLotusLocalEngine = computed(() => selectedRule.value === 'lotus-legacy')
watch(() => activeRemote.value.rulesetId.value, (value) => {
  if (value === 'lotus-classic' || value === 'lotus-legacy' || value === 'lotus-blood-flow') selectedRule.value = value
})

// 类型安全的模式桥：共享状态与动作由 GamePort 显式约束，调试/房间扩展能力不混入 UI 契约。
// local 槽按所选玩法解析到「莲花广麻」或「莲花麻将」本地引擎。
const game = createActiveGamePort(
  gameMode,
  () => selectedRule.value === 'lotus-blood-flow' ? bloodFlowGame : usesLotusLocalEngine.value ? lotusGame : localGame,
  () => activeRemote.value as GamePort,
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
const remoteRulesetId = computed(() => activeRemote.value.rulesetId.value)
const remoteSecondDice = computed<[number, number] | undefined>(() => (
  (activeRemote.value as unknown as { secondDice?: { value?: [number, number] | undefined } }).secondDice?.value
))
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
const debugPreviewDraw = () => {
  if (gameMode.value !== 'local' || singlePlayerOnly.value) return
  localGame.debugPreviewDraw()
}

// ── 联机模式状态（远程房间 / WS 连接）──
// 血流联机房间走自己的会话：以下代理在联机槽切换时读取/写入对应模块的真实 ref。
const proxyRef = <T,>(name: 'sessionStatus' | 'sessionError' | 'roomId' | 'mySeat' | 'nickname'
  | 'playerId' | 'isCreator' | 'roomSeats' | 'reservedSeats' | 'roomTimeLimit' | 'roomStatus'
  | 'roomSync' | 'roomMatch' | 'myMatchId'
  | 'storedSession'
  | 'llmEnabled' | 'effectiveLlmEnabled' | 'llmAvailable' | 'autoPlay'
  | 'roomTableThemeName') => computed<T>({
  get: () => activeRemote.value[name].value as T,
  set: (value: T) => { (activeRemote.value[name] as { value: T }).value = value },
})
const sessionStatus = proxyRef<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'lobby' | 'error' | string>('sessionStatus')
const sessionError = proxyRef<string>('sessionError')
const roomId = proxyRef<string>('roomId')
const mySeat = proxyRef<number>('mySeat')
const nickname = proxyRef<string>('nickname')
const playerId = proxyRef<string>('playerId')
const isCreator = proxyRef<boolean>('isCreator')
const roomSeats = proxyRef<Array<{ seat: number; nickname: string; ready: boolean; connected: boolean; characterId?: string } | null>>('roomSeats')
/** 房主预留的空位（大模型专属，真人不可加入）；未列入的空位「自动选择」= 真人可占。 */
const reservedSeats = proxyRef<Array<LlmSeatRequest>>('reservedSeats')
const roomTimeLimit = proxyRef<number>('roomTimeLimit')
/** 服务端房间状态：blood flow 暂离时房间面板据此显示「本场进行中 · 回到牌桌」。 */
const roomStatus = proxyRef<'lobby' | 'playing' | 'finished' | 'error' | 'closed' | string>('roomStatus')
/** 房间信息同步健康态：轮询连续失败 / 登录过期可见化；面板据此四态渲染。 */
const roomSync = proxyRef<RoomSyncSnapshot>('roomSync')
/** REST 下发的场次身份（matchId 会被下一场覆盖，仅作参考）。 */
const roomMatch = proxyRef<RoomMatchInfo>('roomMatch')
/** WS rejoin_ok 锚定的「我参与的那场」。 */
const myMatchId = proxyRef<string | null>('myMatchId')
const storedSession = proxyRef<StoredSession | null>('storedSession')
const llmEnabled = proxyRef<boolean>('llmEnabled')
const effectiveLlmEnabled = proxyRef<boolean>('effectiveLlmEnabled')
const llmAvailable = proxyRef<boolean>('llmAvailable')
const remoteAutoPlay = proxyRef<boolean>('autoPlay')
const roomTableThemeName = proxyRef<TableThemeName>('roomTableThemeName')
const wsStatus = computed(() => activeRemote.value.wsStatus.value)
const signalQuality = computed(() => activeRemote.value.signalQuality.value)
const waitingNextRound = computed(() => activeRemote.value.waitingNextRound.value)
const toggleAutoPlay = () => activeRemote.value.toggleAutoPlay()
const configureTableTheme = (theme: TableThemeName) => activeRemote.value.configureTableTheme(theme)
// 动作委托：调用瞬间路由到当前联机槽（经典或血流）。
const remoteActions = {
  createRoom: (mode: MatchType, capacity: number, rulesetId?: RuleVariant, llmEnabled?: boolean) =>
    activeRemote.value.remoteActions.createRoom(mode, capacity, rulesetId, llmEnabled),
  joinRoom: async (code: string) => {
    // 联机槽按目标房间玩法路由：血流房间必须走血流模块（先查房间元数据再入房）。
    const info = await getRoom(code).catch(() => null)
    if (info?.rulesetId === 'lotus-blood-flow') {
      // 必须在切槽前取昵称：切槽后读的是血流模块自己的（尚未填写的）空值。
      const carriedNickname = nickname.value
      const carriedPlayerId = playerId.value
      selectedRule.value = 'lotus-blood-flow'
      if (carriedNickname) activeRemote.value.nickname.value = carriedNickname
      if (carriedPlayerId) activeRemote.value.playerId.value = carriedPlayerId
    }
    await activeRemote.value.remoteActions.joinRoom(code)
  },
  toggleReady: () => activeRemote.value.remoteActions.toggleReady(),
  startMatch: (llmSeats?: Parameters<typeof activeRemote.value.remoteActions.startMatch>[0]) =>
    activeRemote.value.remoteActions.startMatch(llmSeats as never),
  // 房主为空位选模型 = 该座预留给大模型（真人不可加入）；改回「自动选择」= 取消预留。
  reserveLlmSeat: (payload: { seat: number; providerId: string | null; style: ServerLlmStyle | null }) =>
    activeRemote.value.remoteActions.reserveLlmSeat(payload.seat, payload.providerId, payload.style),
  leaveRoom: () => activeRemote.value.remoteActions.leaveRoom(),
  closeRoom: () => activeRemote.value.remoteActions.closeRoom(),
  // 暂离（返回大厅）：保留座位与会话，只断开牌桌连接；退出本场：回主大厅但座位仍保留可重进。
  stepOutToLobby: () => activeRemote.value.remoteActions.stepOutToLobby(),
  leaveMatch: () => activeRemote.value.remoteActions.leaveMatch(),
  resumeSession: () => activeRemote.value.remoteActions.resumeSession(),
  updateCharacter: (characterId: string) => activeRemote.value.remoteActions.updateCharacter(characterId),
  // 未同步后面板的「重试」：立刻再拉一次房间真值（1.5s 轮询仍在跑，成功即自愈）。
  refreshRoom: () => activeRemote.value.remoteActions.refreshRoom(),
}

function refreshRoomSync() { void remoteActions.refreshRoom() }

// 房主改主题 → 全房间同步；非房主只读（本地 tableThemeName 随房间主题）。
watch(roomTableThemeName, (theme) => {
  if (gameMode.value === 'remote' && roomId.value) tableThemeName.value = theme
})

// 联机：加入房间后，本家角色变化同步到服务器座位（开局前生效）。
watch(animeCharacterId, (value) => {
  if (gameMode.value === 'remote' && roomId.value && mySeat.value >= 0) {
    void remoteActions.updateCharacter(value).catch(() => {})
  }
})

// 联机房间的大模型能力可能在恢复会话或房间元数据返回后才生效。
watch(effectiveLlmEnabled, (enabled) => preferLlmTableTheme(enabled), { immediate: true })

const { roomMeta } = useRoomAvailability(gameMode, roomId)

const disclaimerGate = useDisclaimerGate()
const wakuAuth = useWakuDemoAuth()

// 联机对战需登录：未登录时不跳转、不弹窗，只在大厅登录卡片处显示内联提示；
// 玩家自行点卡片上的「登录」按钮后，登录成功自动进入联机模式。
const pendingRemoteLogin = ref(false)

function onGameModeChange(mode: GameMode) {
  if (mode === 'remote' && !wakuAuth.authenticated.value) {
    pendingRemoteLogin.value = true
    wakuAuth.error.value = '联机对战需要先登录 WakuDemo 账号'
    return
  }
  gameMode.value = mode
}

// 登录成功后自动进入联机模式（此前玩家已点过联机对战）。
watch(() => wakuAuth.authenticated.value, (authenticated) => {
  if (authenticated && pendingRemoteLogin.value) {
    pendingRemoteLogin.value = false
    gameMode.value = 'remote'
  }
})

// 玩家改选其他模式时放弃「登录后自动进联机」的等待。
watch(gameMode, (mode) => {
  if (mode !== 'remote') pendingRemoteLogin.value = false
})

// 联机接口返回 401 AUTH_REQUIRED 时提示重新登录（不跳转、不弹窗）。
// 提示节流与「重探登录态」间隔同值：401 通常来自 1.5s 一次的房间轮询。
const AUTH_REPROBE_INTERVAL_MS = 5000
let lastAuthReprobeAt = 0

function handleAuthRequired() {
  // 不再用 `!wakuAuth.authenticated.value` 做守卫：客户端那份 authenticated 是
  // 会话过期前的旧值（true），守卫在真正需要它的场景下恒假——事故中 401 已被派发
  // 了 9 分钟，界面既不提示也不重探。
  wakuAuth.error.value = '登录已过期，请重新登录 WakuDemo 账号'
  // 节流地重探登录态：refresh() 会把 authenticated 落到真实值 ⇒ 大厅账号卡片
  // 立刻出现「登录」入口，玩家点它即整页跳转重新登录；回来后 localStorage 会话
  // 仍在，大厅出现「继续对局」，一键恢复原座位。
  const now = Date.now()
  if (now - lastAuthReprobeAt < AUTH_REPROBE_INTERVAL_MS) return
  lastAuthReprobeAt = now
  void wakuAuth.refresh()
}
onMounted(() => window.addEventListener('wakudemo-auth-required', handleAuthRequired))
onBeforeUnmount(() => window.removeEventListener('wakudemo-auth-required', handleAuthRequired))

function startGameWithAudio() {
  if (selectedRule.value === 'lotus-blood-flow' && !bloodFlowEnabled(gameMode.value === 'local' ? 'local' : 'ws')) return
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

// 联机昵称以登录账号为准：账号给出昵称时始终覆盖昵称框（刷新、切换账号都重算，
// 本地旧昵称与玩家手输内容不再优先）；账号没有昵称时保留昵称框原值，玩家仍可自己填。
watch(() => wakuAuth.account.value?.displayName, (displayName) => {
  lobbyController.applyAccountNickname(displayName)
}, { immediate: true })

const statsOpen = ref(false)
// ── 对局回放：列表与查看（只读本机 IndexedDB）──
const replayOpen = ref(false)
const replayView = ref<{ match: ReplayMatch; rounds: ReplayRound[] } | null>(null)
async function openReplay(matchId: string) {
  const match = await replay.storage.loadMatch(matchId)
  if (!match) return
  const rounds = await replay.storage.loadRounds(matchId)
  replayOpen.value = false
  replayView.value = { match, rounds }
}
/** 退出本场（房间面板入口）：座位保留、本场由 AI 代打，回主大厅可再「继续对局」回来。
 *  单机下没有座位/重进码概念，若被触发则按「返回大厅」处理，避免按钮点了没反应。 */
function leaveMatchFromPanel() {
  if (gameMode.value !== 'remote') { returnToLobby(); return }
  if (!window.confirm('退出本场？本场将由 AI 代打（座位与重进码保留），你可以在大厅用「继续对局」回到原座位。')) return
  void remoteActions.leaveMatch()
}
const showLobby = computed(() => (
  phase.value === 'lobby'
  || (gameMode.value === 'remote' && Boolean(roomId.value) && players.value.length === 0)
))
watch(showLobby, (value) => {
  if (value) resetTableReady()
  else llmOpen.value = false
}, { immediate: true })

// 回放落库时机：场末按引擎最终 standings 记录名次；中途回大厅按已打完的局收尾（标「未完成」）。
watch(matchFinished, (finished) => {
  if (!finished) return
  replay.finishAuto(standings.value.map((entry) => ({
    seat: entry.playerIndex,
    name: entry.name,
    score: entry.score,
    rank: entry.rank,
  })))
  // 分析记录收尾：刷队列 → 返回分析区状态 → 按展示回放清单回收悬空分析区（§9.2、§9.5）。
  void analysis.finish().then(async (result) => {
    if (result.matchId && result.status !== 'complete') {
      console.warn('[analysis] 本场分析不完整（可在分析区查看缺失原因）', result)
    }
    await reconcileAnalysisWithReplay(analysisStorage, (await replay.storage.list()).map((match) => match.id))
  })
})
// 分析录制开局：本地血流对局进入开局阶段时开一场（每场一个新录制器，引擎持稳定代理）。
watch(() => (gameMode.value === 'local' && selectedRule.value === 'lotus-blood-flow' ? phase.value : null), (value) => {
  if (value !== 'opening' || analysis.active()) return
  analysis.start({
    // 与展示回放**共用同一个场次 id**（§9.2）：否则分析数据在"按展示回放清单回收"时会被当成
    // 悬空数据整场删掉，列表也无从显示这场是「完整」还是「已删除」。
    matchId: replay.ensureMatchId(),
    rulesetId: 'lotus-blood-flow',
    rules: BLOOD_FLOW_CONFIG,
    rulesVersion: BLOOD_FLOW_CONFIG.version,
    // 本地 AI 与 LLM 两套配置都记下来：分析时要能分辨某一手是谁在什么配置下决定的（§3.1）。
    aiConfig: { local: BLOOD_FLOW_AI, llm: BLOOD_FLOW_LLM_AI },
    aiStrategy: 'source-v2',
    // 本地单机的本家固定是 0 号座（与展示回放的 humanSeat 口径一致）。
    seatControl: players.value.map((player, seat): AnalysisSeatControl => (
      seat === 0 ? 'human' : (player?.playerKind === 'llm' || player?.isLlm) ? 'llm' : 'local-ai'
    )),
  })
}, { immediate: true })
watch(showLobby, (lobby) => {
  if (lobby) replay.finishAuto()
})

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
  // 血流自带结算面板倒计时（锚点是局末演出播完），关掉这一份经典倒计时：
  // 它在血流下不显示，却会在结算快照到达后 10s 静默回执，表现为「倒计时没到 0 就进下一局」。
  enabled: computed(() => !capabilities.value.bloodFlow),
})

// 联机房间内主题切换锁定：非房主始终锁定；房主开局后也锁定（大厅阶段可改）。
const themeLocked = computed(() => (
  gameMode.value === 'remote' && Boolean(roomId.value)
    && (!isCreator.value || phase.value !== 'lobby')
))
const themeLockReason = computed(() => (
  isCreator.value ? '对局开始后锁定主题' : '主题由房主控制'
))

function changeTableTheme(theme: TableThemeName) {
  if (gameMode.value === 'remote' && roomId.value) {
    // 联机房间内主题由房主权威控制：非房主（或开局后）禁用切换。
    if (!isCreator.value) return
    tableThemeName.value = theme
    configureTableTheme(theme)
    activeRemote.value.updatePresentationAudioMode()
    return
  }
  tableThemeName.value = theme
  explicitTableThemeSelected.value = true
  const url = new URL(window.location.href)
  // 手动选择（包括墨玉）始终写入 URL，确保 LLM 开启时刷新后仍尊重用户覆盖。
  url.searchParams.set('theme', theme)
  window.history.replaceState(window.history.state, '', url)
}

</script>

<template>
  <OrientationGate :theme-name="tableThemeName" />
  <main
    class="game-app"
    :class="[{ 'is-lobby': showLobby }, themePresentation.typography.headingClass]"
    :data-table-theme="tableThemeName"
    :data-theme-player-frame="themePresentation.hud.playerFrame"
    :data-theme-particle="themePresentation.shell.particle"
    :data-theme-loading="themePresentation.presentation.loading"
    :style="themePresentationStyle"
  >
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
        :base-score="selectedRule === 'lotus-blood-flow' ? BLOOD_FLOW_CONFIG.basePoints : undefined"
        :room-id="roomId"
        :signal-quality="signalQuality"
        :signal-warning-threshold="1"
        :theme-name="tableThemeName"
        :theme-locked="themeLocked"
        :theme-lock-reason="themeLockReason"
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
        :blood-flow="capabilities.bloodFlow"
        :online="gameMode === 'remote'"
        :second-dice="gameMode === 'remote' ? remoteSecondDice : selectedRule === 'lotus-blood-flow' ? bloodFlowGame.secondDice.value ?? undefined : (usesLotusLocalEngine ? lotusSecondDice : undefined)"
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
        @next-round="nextRound"
        @return-to-lobby="returnToLobby"
        @leave-match="leaveMatchFromPanel"
      />

      <LobbyView
        v-if="showLobby"
        :game-mode="gameMode"
        @update:game-mode="onGameModeChange"
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
        :room-status="roomStatus"
        :room-sync="roomSync"
        :room-match="roomMatch"
        :my-match-id="myMatchId"
        :room-seats="roomSeats"
        :reserved-seats="reservedSeats"
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
        @reserve-seat="(payload: { seat: number; providerId: string | null; style: ServerLlmStyle | null }) => remoteActions.reserveLlmSeat(payload)"
        @leave-room="leaveRoom"
        @close-room="closeRoom"
        @leave-match="leaveMatchFromPanel"
        @retry-sync="refreshRoomSync"
        @open-stats="statsOpen = true"
        @open-replay="replayOpen = true"
        @open-rules="rulesOpen = true"
        @waku-login="wakuAuth.login"
        @waku-logout="wakuAuth.logout"
      />

      <SettlementOverlay
        v-if="!capabilities.bloodFlow"
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
      <ReplayListView
        v-model:open="replayOpen"
        :storage="replay.storage"
        :available="replay.available.value"
        :analysis="analysisStorage"
        :analysis-enabled="analysisEnabled"
        @update:analysis-enabled="setAnalysisEnabled"
        @view="openReplay"
      />
      <DisclaimerDialog
        :open="disclaimerGate.open.value"
        @accept="disclaimerGate.accept"
        @decline="disclaimerGate.decline"
      />
      <WinEffectLab
        :open="winEffectLab"
        @preview-win="debugPreviewWin"
        @preview-draw="debugPreviewDraw"
        @preview-kong="debugKong"
        @preview-four-red="debugFourRed"
      />
    </div>
    <RulesPanel :open="rulesOpen" :variant="selectedRule" @close="rulesOpen = false" />
    <button
      v-if="gameMode === 'local' && showLobby"
      class="llm-fab"
      data-action-role="secondary"
      aria-label="AI 设置"
      title="AI 大模型设置（联机由服务端提供商配置）"
      data-testid="llm-fab"
      @click="llmOpen = true"
    ><img :src="robotIconUrl" alt="" aria-hidden="true"></button>
    <LlmSettingsPanel
      :open="llmOpen && showLobby"
      :messages="llmMessages"
      :stats="llmStats"
      :theme-name="tableThemeName"
      @close="llmOpen = false"
      @saved="applyLlmSettings"
    />
    <ReplayViewer
      v-if="replayView"
      :match="replayView.match"
      :rounds="replayView.rounds"
      @close="replayView = null"
    />
  </main>
</template>
