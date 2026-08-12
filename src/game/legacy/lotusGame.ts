// 「莲花麻将」本地引擎组装：把规则/开局/回合/杠/结算/人类/AI 拼成 GamePort。
// 结构仿 core/local/useGame.ts，但整体独立于「莲花广麻」，复用共享的计时/瞬态事件/音效模块。
import { onBeforeUnmount, ref } from 'vue'
import type { TileType } from '../core/contracts/types'
import { defineGamePort } from '../core/contracts/gamePort'
import { createLocalCountdownController } from '../core/local/localCountdownController'
import { createLocalTransientEventPresenter } from '../core/local/localTransientEventPresenter'
import { advanceMatchState } from '../core/local/matchProgress'
import { tileName } from '../core/rules/tiles'
import type { LotusController, LotusHumanBridge } from './lotusControllers'
import { LotusAiController, LotusHumanController } from './lotusControllers'
import { createLotusHuman } from './lotusHuman'
import { createLotusKong } from './lotusKong'
import { createLotusOpening } from './lotusOpening'
import { createLotusSelectors } from './lotusSelectors'
import { createLotusSettlement } from './lotusSettlement'
import { structuralMeldCount } from './lotusSelectors'
import { createLotusGameState, type LotusEndGameOptions } from './lotusState'
import { createLotusTileFlow } from './lotusTileFlow'
import { createLotusTimer } from './lotusTimer'
import { createLotusTurnOrchestrator } from './lotusTurnOrchestrator'

interface UseLotusGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  controllers?: LotusController[]
  countdownEnabled?: boolean
}

export function useLotusGame({
  playSound = () => {},
  playSoundAndWait = async () => {},
  controllers: suppliedControllers,
  countdownEnabled = true,
}: UseLotusGameOptions = {}) {
  const state = createLotusGameState()
  const selectors = createLotusSelectors(state)

  let openingTimeline!: ReturnType<typeof createLotusOpening>
  let settlementTimeline!: ReturnType<typeof createLotusSettlement>
  let kong!: ReturnType<typeof createLotusKong>
  let turnOrchestrator!: ReturnType<typeof createLotusTurnOrchestrator>
  let tileFlowExecutor!: ReturnType<typeof createLotusTileFlow>
  let playerActions!: ReturnType<typeof createLotusHuman>
  let countdown!: ReturnType<typeof createLocalCountdownController>
  let transient!: ReturnType<typeof createLocalTransientEventPresenter>

  const humanBridge: LotusHumanBridge = {
    isTurn: ref(false),
    canHu: ref(false),
    canKong: ref<TileType[]>([]),
    canWindKong: ref(false),
    actionPrompt: state.actionPrompt,
    selectedIndex: state.selectedIndex,
    drawnThisTurn: state.userDrewThisTurn,
    turnSeconds: state.turnSeconds,
    activateTurn() {
      state.phase.value = 'discard'
      countdown.startTurn()
    },
    activateHu() {
      state.phase.value = 'prompt'
      countdown.startPrompt()
    },
    activateClaim() {
      state.phase.value = 'prompt'
      countdown.startPrompt()
    },
    activateChi() {
      state.phase.value = 'prompt'
      countdown.startPrompt()
    },
    activateRobKong() {
      state.phase.value = 'prompt'
      transient.announce('可抢杠胡', 'red')
      countdown.startPrompt()
    },
    deactivate() {
      countdown?.stop()
    },
  }
  const humanController = new LotusHumanController(humanBridge)
  const controllers: LotusController[] = suppliedControllers ?? [
    humanController,
    new LotusAiController(),
    new LotusAiController(),
    new LotusAiController(),
  ]

  const timer = createLotusTimer({
    controllers,
    stopCountdown: () => countdown?.stop(),
    cancelOpening: () => openingTimeline?.cancel(),
  })
  transient = createLocalTransientEventPresenter({ state, later: timer.later })

  function endGame(winnerIndex: number, options: LotusEndGameOptions = {}) {
    return settlementTimeline.endGame(winnerIndex, options)
  }

  function endDraw() {
    return settlementTimeline.endDraw()
  }

  function beginTurn(playerIndex: number, options: { skipDraw?: boolean; fromTail?: boolean } = {}) {
    return turnOrchestrator.beginTurn(playerIndex, options)
  }

  settlementTimeline = createLotusSettlement({
    state,
    clearTimers: timer.clear,
    later: timer.later,
    playSound,
    showTableAction: transient.showTableAction,
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

  tileFlowExecutor = createLotusTileFlow({
    state,
    controllers,
    getTurnOrchestrator: () => turnOrchestrator,
    endDraw,
    endGame,
    playSound,
    later: timer.later,
    stopCountdown: countdown.stop,
  })

  openingTimeline = createLotusOpening({
    state,
    clearTimers: timer.clear,
    takeTile: tileFlowExecutor.takeTile,
    wait: timer.wait,
    later: timer.later,
    playSound,
    playSoundAndWait,
    announce: transient.announce,
    getRoundLabel: () => selectors.roundLabel.value,
    beginTurn,
    endGame,
  })
  const startGame = openingTimeline.start

  const tableContext = {
    players: state.players,
    currentPlayer: state.currentPlayer,
    showTableAction: transient.showTableAction,
    showScoreFlow: transient.showScoreFlow,
    playSound,
  }

  kong = createLotusKong({
    state,
    showTableAction: transient.showTableAction,
    showScoreFlow: transient.showScoreFlow,
    playSound,
    later: timer.later,
    beginTurn,
  })
  turnOrchestrator = createLotusTurnOrchestrator({
    state,
    controllers,
    tableContext,
    structuralMeldCount: (playerIndex) => structuralMeldCount(state.players[playerIndex]),
    drawFor: tileFlowExecutor.drawFor,
    performConcealedKong: kong.performConcealedKong,
    performWindKong: kong.performWindKong,
    declareAddedKong: kong.declareAddedKong,
    settleAddedKong: kong.settleAddedKong,
    discardTile: tileFlowExecutor.discardTile,
    endDraw,
    endGame,
    announce: transient.announce,
    later: timer.later,
  })

  playerActions = createLotusHuman({
    state,
    humanController,
    tableContext,
    turnOrchestrator,
    kong,
    getUser: () => selectors.user.value,
    isUserTurn: () => selectors.isUserTurn.value,
    canUserHu: () => selectors.userCanHu.value,
    getUserKongs: () => selectors.userKongs.value,
    userHasWindKong: () => selectors.userHasWindKong.value,
    stopCountdown: countdown.stop,
    startTurnCountdown: countdown.startTurn,
    discardTile: tileFlowExecutor.discardTile,
    beginTurn: (playerIndex, options) => beginTurn(playerIndex, options),
    endGame,
    announce: transient.announce,
    playSound,
    later: timer.later,
  })

  function nextRound() {
    if (!state.result.value || state.matchFinished.value) return
    const next = advanceMatchState({
      round: state.round.value,
      dealer: state.dealer.value,
      honba: state.honba.value,
      matchType: state.matchType.value,
      result: state.result.value,
      playerCount: state.players.length,
    })
    state.round.value = next.round
    state.dealer.value = next.dealer
    state.honba.value = next.honba
    if (next.finished) {
      state.matchFinished.value = true
      state.phase.value = 'finished'
      return
    }
    startGame()
  }

  function returnToLobby() {
    timer.clear()
    state.phase.value = 'lobby'
    state.result.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = false
    state.winningPlayerIndex.value = -1
    state.matchFinished.value = false
    state.players.splice(0, state.players.length)
  }

  onBeforeUnmount(timer.clear)

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
    userHasWindKong: selectors.userHasWindKong,
    // 莲花麻将专属
    flipTile: state.flipTile,
    jokerTiles: state.jokerTiles,
    wallBreakIndex: state.wallBreakIndex,
    flipStack: state.flipStack,
    startGame,
    ...playerActions,
    nextRound,
    returnToLobby,
    tileName,
    humanController,
  })
}

export type LotusGame = ReturnType<typeof useLotusGame>
