import { getCurrentInstance, onBeforeUnmount, ref } from 'vue'
import { defineGamePort, type GameStartOptions } from '../contracts/gamePort'
import type { EndGameOptions, TileType } from '../contracts/types'
import { AiController, HumanController, type HumanBridge, type PlayerController } from '../controllers/playerController'
import type { ActionContext } from '../rules/actions'
import { tileName } from '../rules/tiles'
import { createLocalCountdownController } from './localCountdownController'
import { createLocalDebugScenarios } from './localDebugScenarios'
import { createLocalGameSelectors, structuralMeldCount } from './localGameSelectors'
import { createLocalGameState } from './localGameState'
import { createLocalKongActionExecutor } from './localKongActionExecutor'
import { createLocalMatchLifecycle } from './localMatchLifecycle'
import { createLocalOpeningTimeline } from './localOpeningTimeline'
import { createLocalPlayerActionController } from './localPlayerActionController'
import { createLocalSettlementTimeline } from './localSettlementTimeline'
import { createLocalTileFlowExecutor } from './localTileFlowExecutor'
import { createLocalTimerScheduler } from './localTimerScheduler'
import { createLocalTransientEventPresenter } from './localTransientEventPresenter'
import { createLocalTurnOrchestrator } from './localTurnOrchestrator'
import { DEFAULT_RULESET, type RuleSet } from '../rules/ruleset'
import { createFollowDealerTracker } from '../../shared/runtime/followDealer'
import type { PlayerSeed } from '../../shared/runtime/localOpening'

interface UseGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  controllers?: PlayerController[]
  /** 单机人机：注入座位 1-3 的 AI 控制器（可含 LLM 控制器）；默认启发式 AI 玩家 */
  aiControllers?: PlayerController[]
  /** 单机人机：座位 1-3 的玩家形象（昵称/头像，LLM 人设覆盖） */
  aiPlayerSeeds?: Array<PlayerSeed>
  /** 单机对战是否启用回合倒计时（默认开启；模拟测试依赖倒计时自动出牌/过牌） */
  countdownEnabled?: boolean
  ruleset?: RuleSet
}

export function useGame({
  playSound = () => {},
  playSoundAndWait = async () => {},
  controllers: suppliedControllers,
  aiControllers,
  aiPlayerSeeds,
  countdownEnabled = true,
  ruleset = DEFAULT_RULESET,
}: UseGameOptions = {}) {
  const state = createLocalGameState()
  const selectors = createLocalGameSelectors(state, ruleset)
  let openingTimeline!: ReturnType<typeof createLocalOpeningTimeline>
  let settlementTimeline!: ReturnType<typeof createLocalSettlementTimeline>
  let kongActionExecutor!: ReturnType<typeof createLocalKongActionExecutor>
  let turnOrchestrator!: ReturnType<typeof createLocalTurnOrchestrator>
  let tileFlowExecutor!: ReturnType<typeof createLocalTileFlowExecutor>
  let playerActions!: ReturnType<typeof createLocalPlayerActionController>
  let countdown!: ReturnType<typeof createLocalCountdownController>
  let transientEvents!: ReturnType<typeof createLocalTransientEventPresenter>

  const humanBridge: HumanBridge = {
    isTurn: ref(false),
    canHu: ref(false),
    canKong: ref<TileType[]>([]),
    actionPrompt: state.actionPrompt,
    selectedIndex: state.selectedIndex,
    drawnThisTurn: state.userDrewThisTurn,
    turnSeconds: state.turnSeconds,
    activateTurn() {
      state.phase.value = 'discard'
      countdown.startTurn()
    },
    activateClaim() {
      state.phase.value = 'prompt'
      countdown.startPrompt()
    },
    activateRobKong() {
      state.phase.value = 'prompt'
      transientEvents.announce('可抢杠胡', 'red')
      countdown.startPrompt()
    },
    deactivate() {
      countdown?.stop()
    },
  }
  const humanController = new HumanController(humanBridge)
  const controllers: PlayerController[] = suppliedControllers ?? [
    humanController,
    ...(aiControllers && aiControllers.length ? aiControllers : [new AiController(), new AiController(), new AiController()]),
  ]

  const scheduler = createLocalTimerScheduler({
    controllers,
    stopCountdown: () => countdown?.stop(),
    cancelOpening: () => openingTimeline?.cancel(),
  })
  transientEvents = createLocalTransientEventPresenter({ state, later: scheduler.later })

  // 跟庄：开局第一圈，庄家首弃后三闲家各出一张同牌 → 庄家向三家各付底分。
  const followDealer = createFollowDealerTracker({
    players: state.players,
    dealerIndex: () => state.dealer.value,
    baseScore: ruleset.baseScore,
    onTrigger: (deltas) => {
      transientEvents.showScoreFlow(deltas)
      transientEvents.announce('跟庄')
    },
  })

  function endGame(winnerIndex: number, options: EndGameOptions = {}) {
    return settlementTimeline.endGame(winnerIndex, options)
  }

  function endDraw() {
    return settlementTimeline.endDraw()
  }

  function beginTurn(playerIndex: number, options: { skipDraw?: boolean; fromTail?: boolean } = {}) {
    return turnOrchestrator.beginTurn(playerIndex, options)
  }

  settlementTimeline = createLocalSettlementTimeline({
    state,
    clearTimers: scheduler.clear,
    later: scheduler.later,
    playSound,
    playSoundAndWait,
    showTableAction: transientEvents.showTableAction,
    structuralMeldCount: (playerIndex) => structuralMeldCount(state.players[playerIndex]),
    getRoundLabel: () => selectors.roundLabel.value,
    ruleset,
  })

  countdown = createLocalCountdownController({
    state,
    playSound,
    enabled: countdownEnabled,
    onDiscard: () => playerActions.userDiscard(),
    onPass: () => playerActions.userPass(),
  })

  tileFlowExecutor = createLocalTileFlowExecutor({
    state,
    controllers,
    getTurnOrchestrator: () => turnOrchestrator,
    endDraw,
    endGame,
    showTableAction: transientEvents.showTableAction,
    playSound,
    playSoundAndWait,
    later: scheduler.later,
    wait: scheduler.wait,
    stopCountdown: countdown.stop,
    followDealer,
  })

  openingTimeline = createLocalOpeningTimeline({
    state,
    clearTimers: scheduler.clear,
    takeTile: tileFlowExecutor.takeTile,
    wait: scheduler.wait,
    later: scheduler.later,
    playSound,
    playSoundAndWait,
    announce: transientEvents.announce,
    getRoundLabel: () => selectors.roundLabel.value,
    beginTurn,
    endGame,
    playerSeeds: aiPlayerSeeds,
  })
  // 每局开局先复位跟庄窗口，再走开局时间线。
  const startGame = (mode?: Parameters<typeof openingTimeline.start>[0], options?: GameStartOptions) => {
    followDealer.reset()
    return openingTimeline.start(mode, options)
  }

  const tableContext: ActionContext = {
    players: state.players,
    currentPlayer: state.currentPlayer,
    showTableAction: transientEvents.showTableAction,
    showScoreFlow: transientEvents.showScoreFlow,
    playSound,
  }
  kongActionExecutor = createLocalKongActionExecutor({
    state,
    showTableAction: transientEvents.showTableAction,
    showScoreFlow: transientEvents.showScoreFlow,
    playSound,
    later: scheduler.later,
    beginTurn,
    ruleset,
  })
  turnOrchestrator = createLocalTurnOrchestrator({
    state,
    controllers,
    tableContext,
    structuralMeldCount: (playerIndex) => structuralMeldCount(state.players[playerIndex]),
    drawFor: tileFlowExecutor.drawFor,
    performConcealedKong: kongActionExecutor.performConcealedKong,
    declareAddedKong: kongActionExecutor.declareAddedKong,
    settleAddedKong: kongActionExecutor.settleAddedKong,
    discardTile: tileFlowExecutor.discardTile,
    endDraw,
    endGame,
    announce: transientEvents.announce,
    later: scheduler.later,
    ruleset,
    followDealer,
  })

  playerActions = createLocalPlayerActionController({
    state,
    humanController,
    tableContext,
    turnOrchestrator,
    kongActionExecutor,
    getUser: () => selectors.user.value,
    isUserTurn: () => selectors.isUserTurn.value,
    canUserHu: () => selectors.userCanHu.value,
    getUserKongs: () => selectors.userKongs.value,
    stopCountdown: countdown.stop,
    startTurnCountdown: countdown.startTurn,
    discardTile: tileFlowExecutor.discardTile,
    beginTurn: (playerIndex, options) => beginTurn(playerIndex, options),
    endGame,
    announce: transientEvents.announce,
    playSound,
    later: scheduler.later,
  })

  const matchLifecycle = createLocalMatchLifecycle({ state, clearTimers: scheduler.clear, startGame })
  const debugScenarios = createLocalDebugScenarios({
    state,
    clearTimers: scheduler.clear,
    resetPlayers: openingTimeline.resetPlayers,
    announce: transientEvents.announce,
    endGame,
    beginTurn: (playerIndex) => beginTurn(playerIndex),
  })

  // 模拟测试里没有组件实例，直接注册会触发 Vue 警告；与 useRemoteGame.ts 同款守卫。
  if (getCurrentInstance()) onBeforeUnmount(scheduler.clear)

  return defineGamePort({
    phase: state.phase,
    players: state.players,
    wall: state.wall,
    wallHeadDrawn: state.wallHeadDrawn,
    wallCount: selectors.wallCount,
    currentPlayer: state.currentPlayer,
    selectedIndex: state.selectedIndex,
    turnSeconds: state.turnSeconds,
    lastDiscard: state.lastDiscard,
    actionPrompt: state.actionPrompt,
    announcement: state.announcement,
    tableActionEvent: state.tableActionEvent,
    scoreFlowEvent: state.scoreFlowEvent,
    result: state.result,
    winEffect: state.winEffect,
    winPresentation: state.winPresentation,
    revealHands: state.revealHands,
    winningPlayerIndex: state.winningPlayerIndex,
    round: state.round,
    dealer: state.dealer,
    user: selectors.user,
    isUserTurn: selectors.isUserTurn,
    userCanHu: selectors.userCanHu,
    matchType: state.matchType,
    matchName: selectors.matchName,
    matchFinished: state.matchFinished,
    honba: state.honba,
    roundLabel: selectors.roundLabel,
    standings: selectors.standings,
    dealAnimation: state.dealAnimation,
    openingStage: state.openingStage,
    diceValues: state.diceValues,
    diceThrowerIndex: state.diceThrowerIndex,
    userCurrentWaits: selectors.userCurrentWaits,
    userTingOptions: selectors.userTingOptions,
    userDiscardWaits: selectors.userDiscardWaits,
    userKongs: selectors.userKongs,
    capabilities: ref({}),
    startGame,
    ...playerActions,
    ...matchLifecycle,
    tileName,
    ...debugScenarios,
    humanController,
  })
}
