import type { RemoteGameState } from '../state/remoteGameState'
import type { RoundStartMessage } from '../protocol/messages'
import type { ServerSnapshot } from '../protocol/dto'

export interface RemoteMatchLifecycleOptions {
  state: RemoteGameState
  isShowingRoundResult(): boolean
  clearTimers(): void
  opening: {
    start(message: RoundStartMessage): void
    cancel(): void
  }
  settlement: { cancel(): void }
  snapshots: {
    reset(): void
    clearPending(): void
    takePending(): ServerSnapshot | null
    apply(snapshot: ServerSnapshot): void
  }
  requests: {
    reset(): void
    clearPending(): void
    flush(): void
  }
  transientEvents: { clear(): void }
  sendContinue(): void
  refreshRoom(): void | Promise<void>
}

export function createRemoteMatchLifecycle({
  state,
  isShowingRoundResult,
  clearTimers,
  opening,
  settlement,
  snapshots,
  requests,
  transientEvents,
  sendContinue,
  refreshRoom,
}: RemoteMatchLifecycleOptions) {
  let pendingRoundStart: RoundStartMessage | null = null

  function clearRoundBarrier() {
    pendingRoundStart = null
    state.waitingNextRound.value = false
  }

  function handleRoundStart(message: RoundStartMessage) {
    const alreadyConfirmed = state.waitingNextRound.value
    state.waitingNextRound.value = false
    if (isShowingRoundResult() && !alreadyConfirmed) {
      pendingRoundStart = message
      return
    }
    pendingRoundStart = null
    opening.start(message)
  }

  function finishMatch(finalScores: Array<{ seat: number; name: string; score: number }>) {
    settlement.cancel()
    snapshots.clearPending()
    requests.clearPending()
    clearRoundBarrier()
    state.matchFinished.value = true
    state.phase.value = 'finished'
    state.result.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = true
    state.winningPlayerIndex.value = -1
    const scores = new Map(finalScores.map((entry) => [entry.seat, entry.score]))
    state.players.forEach((player) => {
      const score = scores.get(player.seat)
      if (score != null) player.score = score
    })
  }

  function resetAll() {
    clearTimers()
    snapshots.reset()
    requests.reset()
    clearRoundBarrier()
    opening.cancel()
    state.openingStage.value = null
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: 0 }
    state.diceValues.value = [1, 1]
    state.phase.value = 'lobby'
    state.players.splice(0, state.players.length)
    state.wall.value = []
    state.wallHeadDrawn.value = 0
    state.wallCount.value = 0
    state.rulesetId.value = 'lotus-classic'
    state.secondDice.value = [1, 1]
    state.flipTile.value = null
    state.jokerTiles.value = []
    state.wildcardTiles.value = []
    state.flipStack.value = null
    state.openingStack.value = null
    state.wallBreakIndex.value = 0
    state.turnCanHu.value = false
    state.turnCanWindKong.value = false
    state.currentPlayer.value = -1
    state.selectedIndex.value = -1
    state.turnSeconds.value = 12
    state.userDrewThisTurn.value = false
    state.lastDiscard.value = null
    state.actionPrompt.value = null
    transientEvents.clear()
    state.result.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = false
    state.winningPlayerIndex.value = -1
    state.round.value = 1
    state.dealer.value = 0
    state.honba.value = 0
    state.matchFinished.value = false
    state.roomId.value = ''
    state.mySeat.value = -1
    state.nickname.value = ''
    state.rejoinCode.value = ''
    state.creatorSeat.value = null
    state.isCreator.value = false
    state.roomSeats.value = []
    state.roomTimeLimit.value = null
    state.sessionStatus.value = 'idle'
    state.sessionError.value = ''
  }

  function nextRound() {
    settlement.cancel()
    if (state.matchFinished.value) return
    sendContinue()
    state.waitingNextRound.value = true

    if (pendingRoundStart) {
      const message = pendingRoundStart
      pendingRoundStart = null
      state.waitingNextRound.value = false
      opening.start(message)
    }

    const pendingSnapshot = snapshots.takePending()
    if (pendingSnapshot && !(pendingSnapshot.phase === 'settled' && pendingSnapshot.result)) {
      snapshots.apply(pendingSnapshot)
    }
    requests.flush()
  }

  function returnToLobby() {
    if (!state.matchFinished.value) return
    settlement.cancel()
    requests.reset()
    snapshots.clearPending()
    clearRoundBarrier()
    state.matchFinished.value = false
    state.result.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = false
    state.winningPlayerIndex.value = -1
    state.lastDiscard.value = null
    state.actionPrompt.value = null
    transientEvents.clear()
    state.selectedIndex.value = -1
    state.currentPlayer.value = -1
    state.wall.value = []
    state.wallHeadDrawn.value = 0
    state.wallCount.value = 0
    state.players.splice(0, state.players.length)
    state.phase.value = 'lobby'
    void refreshRoom()
  }

  return {
    handleRoundStart,
    finishMatch,
    resetAll,
    nextRound,
    returnToLobby,
    clearRoundBarrier,
  }
}
