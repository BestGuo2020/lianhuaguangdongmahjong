<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, shallowRef, watch } from 'vue'
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
import { bloodFlowEnabled } from './game/variants/lotus/bloodFlow/availability'
import { BLOOD_FLOW_CONFIG } from './game/variants/lotus/bloodFlow/config'
import { createLocalLlmControllers, createLotusLlmControllers } from './game/llm/runtime'
import type { LlmControllerStats } from './game/llm/llmController'
import { createAnimeFixedTtsExecutor } from './game/llm/animeFixedTtsExecutor'
import { createActiveGamePort, type GameMode } from './game/core/contracts/activeGamePort'
import { useVibeRemoteGame } from './game/online/useVibeRemoteGame'
import { createRemoteLobbyController } from './game/online/orchestration/remoteLobbyController'
import { useDisclaimerGate } from './game/online/session/useDisclaimerGate'
import { useRemoteContinueCountdown } from './game/online/presentation/useRemoteContinueCountdown'
import { useAudio } from './game/core/presentation/useAudio'
import { preloadAnimeCharacterAssets } from './game/core/presentation/llmAnimeAssets'
import { defaultAvatarForSeat } from './game/core/presentation/avatar'
import { initVibeHub, loginRequired, vibeUser } from './game/online/vibe/vibeClient'
import type { MatchType, TileType } from './game/core/contracts/types'
import { DEFAULT_RULE_VARIANT, getRuleVariant, type RuleVariant } from './game/core/rules/ruleVariants'
import { useReplayRecorder } from './game/replay/useReplayRecorder'
import { createAnalysisStorage } from './game/replay/analysis/storage'
import { createAnalysisSession, reconcileAnalysisWithReplay } from './game/replay/analysis/session'
import type { AnalysisSeatControl } from './game/replay/analysis/types'
import { BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI } from './game/variants/lotus/bloodFlow/config'
import type { ReplayMatch, ReplayRound } from './game/replay/types'
import type { TableThemeName } from './components/table/three/tableTheme'
import { themePresentationByName, themePresentationCssVariables } from './theme/themePresentation'
import { resolveInitialTableTheme, shouldAutoUseLlmTheme } from './components/table/three/tableThemePreference'
import { listHostLlmOptions } from './game/online/vibe/vibeLlm'
import type { PlayerSeed } from './game/shared/runtime/localOpening'
import { readAnimeCharacterPreference, saveAnimeCharacterPreference } from './game/llm/animeCharacterPreference'
import type { CharacterId } from './game/llm/animeCharacters'

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
  tableReadyResolve?.()
  tableReadyResolve = null
  tableReadyPromise = null
}
const initialThemeCandidate = new URLSearchParams(window.location.search).get('theme')
const initialTableTheme = resolveInitialTableTheme(initialThemeCandidate)
const tableThemeName = ref<TableThemeName>(initialTableTheme.theme)
const themePresentation = computed(() => themePresentationByName(tableThemeName.value))
const themePresentationStyle = computed(() => themePresentationCssVariables(themePresentation.value))
const explicitTableThemeSelected = ref(initialTableTheme.explicit)
const winEffectLab = import.meta.env.DEV && new URLSearchParams(window.location.search).has('winEffectLab')
const { soundOn, playEffect, playEffectAndWait, startBgm } = useAudio()

// 联机 SDK 初始化：生产用真实 VibeHub（平台生产域 gamesvibe.app，见 vibeClient.isPlatformHost；
// 旧域名 lumigrav.space 已弃用）；本地开发用内置 mock（BroadcastChannel 模拟房间/对端），
// 不发布即可双窗口联调联机逻辑。
void initVibeHub()

const gameMode = ref<GameMode>('local')
// AI 大模型（单机人机座位 1-3）：仅大厅可配置；保存后立即装配到下一次开局。
const llmOpen = ref(false)
const llmMessages = ref<string[]>([])
/** 牌桌气泡：key=座位绝对索引，value=最近一条吐槽（4 秒后自动消失） */
const llmBubbles = ref<Record<number, { text: string; id: number }>>({})
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
  // 二次元主题：角色头像与鸣牌/胡牌立绘在开局前预热；immediate 让 `?theme=llmAnime`
  // 直接进入（或恢复上次主题）也预取，而不是只在切换到该主题时预取。
  if (theme === 'llmAnime') {
    void preloadAnimeCharacterAssets()
    return
  }
  localAnimeFixedTts.cancel()
  lotusAnimeFixedTts.cancel()
  remoteAnimeFixedTts.cancel()
}, { immediate: true })
const localLlm = shallowRef(createLocalLlmControllers(llmHook))
const lotusLlm = shallowRef(createLotusLlmControllers(llmHook))

function preferLlmTableTheme(llmEnabled: boolean) {
  if (shouldAutoUseLlmTheme(llmEnabled, explicitTableThemeSelected.value)) tableThemeName.value = 'llm'
}

preferLlmTableTheme(localLlm.value.enabled || lotusLlm.value.enabled)
// 引擎在 setup 阶段创建，保存配置时通过原地更新种子数组让下一次开局使用新的人设。
const localLlmSeeds = localLlm.value.seeds
const lotusLlmSeeds = lotusLlm.value.seeds
const animeCharacterId = ref<CharacterId>(readAnimeCharacterPreference())
// 本家头像始终是本地默认头像；二次元角色头像只由 `llmAnime` 的表现层覆盖
// （GameTableHud / SettlementOverlay / BloodFlowResultPlayers 按主题选择），
// 这样非 llmAnime 主题不会显示角色头像，llm 主题只有本家/真人是非大模型头像。
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
const vibeLlmOptions = listHostLlmOptions()
const llmStats = computed<LlmControllerStats>(() => ({
  requests: localLlm.value.stats.requests + lotusLlm.value.stats.requests,
  successes: localLlm.value.stats.successes + lotusLlm.value.stats.successes,
  fallbacks: localLlm.value.stats.fallbacks + lotusLlm.value.stats.fallbacks,
  messages: localLlm.value.stats.messages + lotusLlm.value.stats.messages,
  invalidActions: localLlm.value.stats.invalidActions + lotusLlm.value.stats.invalidActions,
}))
// ── 对局回放（只存本机 IndexedDB，不上服务器）──
// 录制器在三个单机引擎之间共享：同一时刻只有所选玩法的引擎在跑，局序不会交错。
// ── AI 分析记录（方案 docs/blood-flow/design/replay-ai-analysis-recording.md）──
// 独立分析区（自己的数据库与失败域，§9.2/§9.5）；默认关闭，dev 打开以便本地验证。
// 开关只影响分析录制，不改变任何策略动作或对局结果（§10.1、§10.7）。
const analysisStorage = createAnalysisStorage()
const analysisEnabled = ref(import.meta.env.DEV
  ? localStorage.getItem('lgm_analysis_enabled') !== '0'
  : localStorage.getItem('lgm_analysis_enabled') === '1')
const analysis = createAnalysisSession({
  enabled: analysisEnabled.value,
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
  getTableThemeName: () => tableThemeName.value,
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
  getTableThemeName: () => tableThemeName.value,
  animeFixedTts: lotusAnimeFixedTts,
  recorder: replay.hooks,
})
const bloodFlowGame = useBloodFlowGame({ playSound: playEffect, playSoundAndWait: playEffectAndWait,
  getThemeName: () => tableThemeName.value, animeFixedTts: lotusAnimeFixedTts, countdownEnabled: false,
  humanPlayerSeed: localHumanSeed, aiPlayerSeeds: lotusLlmSeeds, recorder: replay.hooks,
  // AI 分析记录：引擎拿到的是一个稳定代理（换场只换内部录制器）；关闭时为 null，零成本。
  analysis: analysis.port })
/**
 * 联机（P2P）分析记录开场（§6）：血流房间在拿到**本场分析区场次 id** 时调这里。
 * 房主的场次 id 就是它那份展示回放的 id；客机从房主的快照信封里取 —— 两边同一个 id，
 * 客机那份分析数据才不会在"按展示回放清单回收"时被当成悬空数据删掉（§9.2）。
 */
function startOnlineAnalysis(detail: { matchId: string; seatControl: AnalysisSeatControl[] }) {
  if (!analysisEnabled.value || !detail.matchId) return
  if (analysis.active()) {
    if (analysis.matchId() === detail.matchId) return
    // 上一场没正常收尾（中途换场/离开房间重开）：先如实收尾，避免这一场挂到上一场名下
    void analysis.finish().then(() => beginOnlineAnalysis(detail))
    return
  }
  beginOnlineAnalysis(detail)
}
function beginOnlineAnalysis(detail: { matchId: string; seatControl: AnalysisSeatControl[] }) {
  analysis.start({
    matchId: detail.matchId,
    rulesetId: 'lotus-blood-flow',
    rules: BLOOD_FLOW_CONFIG,
    rulesVersion: BLOOD_FLOW_CONFIG.version,
    // 联机时 AI/LLM 两套配置可能来自房主/各玩家的本机设置，这里记下本机口径（§3.1）
    aiConfig: { local: BLOOD_FLOW_AI, llm: BLOOD_FLOW_LLM_AI },
    aiStrategy: 'source-v2',
    // 座位口径由房间给出（**绝对座位**）：客机视角是旋转过的，不能拿本机视角的座位号来标
    seatControl: detail.seatControl,
  })
}
const vibeRemoteGame = useVibeRemoteGame({
  playSound: playEffect,
  playSoundAndWait: playEffectAndWait,
  waitForTableReady,
  // 联机牌谱：房主生成全知牌谱广播给全员，各自存进同一个本地库（与单机回放共用一个列表）
  replayStorage: replay.storage,
  // §6 联机分析记录：本机座位/AI 座位的决策 + 房主局后下发的赛后私有复现数据
  analysis: analysis.port,
  onAnalysisMatchId: startOnlineAnalysis,
  onLlmMessage: llmHook.onLlmMessage,
  getTableThemeName: () => tableThemeName.value,
  getCharacterId: () => animeCharacterId.value,
  animeFixedTts: remoteAnimeFixedTts,
})

// 莲花麻将旧版翻精规则同时支持本地与联机对战。
const singlePlayerOnly = computed(() => false)
const usesLotusLocalEngine = computed(() => selectedRule.value === 'lotus-legacy')
watch(() => vibeRemoteGame.rulesetId.value, (value) => {
  if (value === 'lotus-classic' || value === 'lotus-legacy' || value === 'lotus-blood-flow') selectedRule.value = value
})

// 类型安全的模式桥：共享状态与动作由 GamePort 显式约束，调试/房间扩展能力不混入 UI 契约。
// local 槽按所选玩法解析到「莲花广麻」或「莲花麻将」本地引擎；远程槽房主与客户端统一用
// vibeRemoteGame 的快照驱动表现层（房主自视快照/事件在 useVibeRemoteGame 内本地喂入）。
const game = createActiveGamePort(
  gameMode,
  () => selectedRule.value === 'lotus-blood-flow' ? bloodFlowGame : usesLotusLocalEngine.value ? lotusGame : localGame,
  () => vibeRemoteGame.rulesetId.value === 'lotus-blood-flow' ? vibeRemoteGame.bloodFlowPort : vibeRemoteGame,
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
const remoteRulesetId = computed(() => vibeRemoteGame.rulesetId.value)
const remoteSecondDice = computed(() => vibeRemoteGame.secondDice.value)
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
  sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, avatar, playerId, isHost, roomSeats, aiSeats, roomTimeLimit, remoteActions, waitingNextRound, signalQuality,
  rejoining,
  roomTableThemeName,
  autoPlay: remoteAutoPlay, toggleAutoPlay,
} = vibeRemoteGame

watch(roomTableThemeName, (themeName) => {
  if (gameMode.value === 'remote' && roomId.value) tableThemeName.value = themeName
})
watch([gameMode, roomId], ([mode, currentRoomId]) => {
  if (mode === 'remote' && currentRoomId) tableThemeName.value = roomTableThemeName.value
})
// 联机房间内本家角色变化 → 同步到大厅座位（房主广播 / 客户端发送 lobby_character）。
watch(animeCharacterId, (value) => {
  if (gameMode.value === 'remote' && roomId.value) remoteActions.updateCharacter(value)
})

// SDK 无服务端房间容量元数据，「剩余房间」不再展示。
const roomMeta = ref(null)

const disclaimerGate = useDisclaimerGate(playerId)

function startGameWithAudio() {
  if (selectedRule.value === 'lotus-blood-flow' && !bloodFlowEnabled('local')) return
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

// P1 重连：刷新页面自动重进上次的房间（对局进行中则快照重同步 + rejoin_ok 恢复座位）。
// 生产环境需先登录（SDK token 不落盘），未登录就 join 会失败或留下半状态（只响声音
// 进不去游戏）；本地（mock 匿名）无需登录，立即重进。登录后的重进由 vibeUser watch 触发。
onMounted(async () => {
  await initVibeHub()
  // 初始化期间的登录回调也可能已开始恢复；只在空闲时发起一次自动重进。
  if (vibeRemoteGame.savedSessionExists.value && !loginRequired.value && sessionStatus.value === 'idle') lobbyController.resumeSession()
})
const {
  nicknameInput, joinCode, allOccupiedReady, copied, matchStarting, leaving, closing,
  createRoom: createRemoteRoom,
  joinRoom: joinRemoteRoom,
  copyRoomCode,
  startMatch: startRemoteMatch,
  quitMatch,
  leaveRoom,
  closeRoom,
  report: reportPlayer,
  toggleReady,
} = lobbyController

// 登录后以 VibeHub 账号 id 作为联机 playerId，昵称取公开资料，头像取 SDK 用户头像。
watch(vibeUser, (user) => {
  if (!user) return
  playerId.value = user.id
  if (user.name) {
    nickname.value = user.name
    nicknameInput.value = user.name
  }
  if (user.image) avatar.value = user.image
  // 刷新页面后 SDK 需重新授权（token 仅驻内存）；登录完成后若存在保存的房间会话
  // 且尚未在房间中 → 自动重进（对局进行中则快照重同步 + 座位恢复）。
  // 重进后若数据通道建不起来（SDK 残留旧 RTCPeerConnection）→ 自动重试加入。
  if (vibeRemoteGame.savedSessionExists.value && !roomId.value) {
    lobbyController.resumeSession()
    vibeRemoteGame.scheduleRejoinRetry()
  }
})

const statsOpen = ref(false)
const showLobby = computed(() => (
  phase.value === 'lobby'
  || (gameMode.value === 'remote' && Boolean(roomId.value) && players.value.length === 0)
))
watch(showLobby, (value) => {
  if (value) resetTableReady()
  else llmOpen.value = false
}, { immediate: true })

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
// 回放落库时机：场末按引擎最终 standings 记录名次；中途回大厅按已打完的局收尾（标「未完成」）。
// 分析录制开局：本地血流对局进入开局阶段时开一场（每场一个新录制器，引擎持稳定代理）。
// 联机血流对局由房间在拿到场次 id 时调 `startOnlineAnalysis`（见上）。
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
watch(matchFinished, (finished) => {
  if (!finished) return
  replay.finishAuto(standings.value.map((entry) => ({
    seat: entry.playerIndex,
    name: entry.name,
    score: entry.score,
    rank: entry.rank,
  })))
  // §6：先把还在路上的赛后复现数据结清（等一小段，仍未到就如实记"未收到"/"权威端未提供"），
  // **再**结束分析会话 —— 会话结束后的写入会被丢弃，"还没收到"就变成一片空白。
  void (gameMode.value === 'remote'
    ? vibeRemoteGame.settleBloodFlowAnalysis()
    : Promise.resolve()
  ).then(() => analysis.finish()).then(async (result) => {
    if (result.matchId && result.status !== 'complete') {
      console.warn('[analysis] 本场分析不完整（可在分析区查看缺失原因）', result)
    }
    await reconcileAnalysisWithReplay(analysisStorage, (await replay.storage.list()).map((match) => match.id))
  })
})
watch(showLobby, (lobby) => {
  if (lobby) replay.finishAuto()
})

function applyLlmSettings() {
  // 保存事件只会在大厅触发；运行中的对局不会被切换模型打断。
  if (!showLobby.value || gameMode.value !== 'local') return

  const nextLocalLlm = createLocalLlmControllers(llmHook)
  localGame.replaceAiControllers(nextLocalLlm.controllers)
  localLlmSeeds.splice(0, localLlmSeeds.length, ...nextLocalLlm.seeds)
  nextLocalLlm.seeds = localLlmSeeds
  localLlm.value = nextLocalLlm

  const nextLotusLlm = createLotusLlmControllers(llmHook)
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
    ? roomSeats.value.map((seat) => seat.seat)
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
  if (gameMode.value === 'remote' && roomId.value && !isHost.value) {
    tableThemeName.value = roomTableThemeName.value
    return
  }
  tableThemeName.value = theme
  explicitTableThemeSelected.value = true
  if (gameMode.value === 'remote' && roomId.value && isHost.value) remoteActions.configureTableTheme(theme)
  const url = new URL(window.location.href)
  url.searchParams.set('theme', theme)
  window.history.replaceState(window.history.state, '', url)
}

// 联机房间内主题切换锁定：非房主始终锁定；房主开局后也锁定（大厅阶段可改）。
const themeLocked = computed(() => (
  gameMode.value === 'remote' && Boolean(roomId.value)
    && (!isHost.value || phase.value !== 'lobby')
))
const themeLockReason = computed(() => (
  isHost.value ? '对局开始后锁定主题' : '主题由房主控制'
))

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
    <div v-if="gameMode === 'remote' && wsStatus === 'reconnecting' && !matchFinished" class="remote-banner" role="status">{{ phase === 'lobby' ? '网络断开，正在重连…' : '房主连接中断，等待恢复…' }}</div>
    <div v-else-if="gameMode === 'remote' && wsStatus === 'closed' && roomId && !matchFinished" class="remote-banner error" role="status">连接已断开，正在尝试恢复…</div>
    <div v-if="gameMode === 'remote' && rejoining" class="remote-banner" role="status">尝试重新加入房间…</div>
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
        :sound-on="soundOn"
        :theme-name="tableThemeName"
        :theme-locked="themeLocked"
        :theme-lock-reason="themeLockReason"
        @quit="quitMatch"
        @toggle-sound="soundOn = !soundOn"
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
          :ruleset-id="gameMode === 'remote' ? remoteRulesetId : selectedRule"
          :blood-flow="capabilities.bloodFlow"
          :online="false"
          :second-dice="gameMode === 'remote' ? (capabilities.bloodFlow ? vibeRemoteGame.bloodFlowPort.secondDice.value ?? undefined : remoteSecondDice) : selectedRule === 'lotus-blood-flow' ? bloodFlowGame.secondDice.value ?? undefined : (usesLotusLocalEngine ? lotusSecondDice : undefined)"
          :flip-tile="flipTile"
          :wall-break-index="wallBreakIndex"
          :flip-stack="flipStack"
          :theme-name="tableThemeName"
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
          :room-id="roomId"
          :match-name="matchName"
          :room-meta="roomMeta"
          :session-status="sessionStatus"
          :session-error="sessionError"
          :room-time-limit="roomTimeLimit"
          :room-seats="roomSeats"
          :ai-seats="aiSeats"
          :llm-options="vibeLlmOptions"
          :my-seat="mySeat"
          :is-host="isHost"
          :single-player-only="singlePlayerOnly"
          :all-occupied-ready="allOccupiedReady"
          :match-starting="matchStarting"
          :copied="copied"
          :leaving="leaving"
          :closing="closing"
          @start-local="startGameWithAudio"
          @create-room="createRemoteRoom"
          @join-room="joinRemoteRoom"
          @copy-room="copyRoomCode"
          @toggle-ready="toggleReady"
          @start-remote="startRemoteMatch"
          @configure-ai-seats="remoteActions.configureAiSeats"
          @leave-room="leaveRoom"
          @close-room="closeRoom"
          @open-stats="statsOpen = true"
          @open-replay="replayOpen = true"
          @open-rules="rulesOpen = true"
        />

        <SettlementOverlay v-if="!capabilities.bloodFlow"
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
      title="AI 大模型设置"
      data-testid="llm-fab"
      @click="llmOpen = true"
    ><img :src="robotIconUrl" alt="" aria-hidden="true"></button>
    <LlmSettingsPanel
      :open="llmOpen && showLobby"
      :theme-name="tableThemeName"
      :messages="llmMessages"
      :stats="llmStats"
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
