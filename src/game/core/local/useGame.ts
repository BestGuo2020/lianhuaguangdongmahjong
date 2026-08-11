import { onBeforeUnmount, ref } from 'vue'
import { defineGamePort } from '../contracts/gamePort'
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

interface UseGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  controllers?: PlayerController[]
  /** 单机对战是否启用回合倒计时（默认开启；模拟测试依赖倒计时自动出牌/过牌） */
  countdownEnabled?: boolean
}

export function useGame({
  playSound = () => {},
  playSoundAndWait = async () => {},
  controllers: suppliedControllers,
  countdownEnabled = true,
}: UseGameOptions = {}) {
  const state = createLocalGameState()
  const selectors = createLocalGameSelectors(state)
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
    new AiController(),
    new AiController(),
    new AiController(),
  ]

  const scheduler = createLocalTimerScheduler({
    controllers,
    stopCountdown: () => countdown?.stop(),
    cancelOpening: () => openingTimeline?.cancel(),
  })
  transientEvents = createLocalTransientEventPresenter({ state, later: scheduler.later })

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
    showTableAction: transientEvents.showTableAction,
    structuralMeldCount: (playerIndex) => structuralMeldCount(state.players[playerIndex]),
    getRoundLabel: () => selectors.roundLabel.value,
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
  })
  const startGame = openingTimeline.start

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

  onBeforeUnmount(scheduler.clear)

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
    userCurrentWaits: selectors.userCurrentWaits,
    userTingOptions: selectors.userTingOptions,
    userDiscardWaits: selectors.userDiscardWaits,
    userKongs: selectors.userKongs,
    startGame,
    ...playerActions,
    ...matchLifecycle,
    tileName,
    ...debugScenarios,
    humanController,
  })
}
