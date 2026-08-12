import type { GamePhase, RefLike, RoundResult, WinEffect } from '../../core/contracts/gamePort'
import type { GamePlayer, MatchType, WinPresentation } from '../../core/contracts/types'
import { advanceMatchState } from '../../core/local/matchProgress'

interface MatchLifecycleState {
  result: RefLike<RoundResult | null>
  matchFinished: RefLike<boolean>
  round: RefLike<number>
  dealer: RefLike<number>
  honba: RefLike<number>
  matchType: RefLike<MatchType>
  phase: RefLike<GamePhase>
  winEffect: RefLike<WinEffect | null>
  winPresentation: RefLike<WinPresentation | null>
  revealHands: RefLike<boolean>
  winningPlayerIndex: RefLike<number>
  players: GamePlayer[]
}

interface MatchLifecycleOptions {
  state: MatchLifecycleState
  clearTimers(): void
  startGame(mode?: MatchType): unknown
}

export function createMatchLifecycle(options: MatchLifecycleOptions) {
  const { state } = options

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
    options.startGame()
  }

  function returnToLobby() {
    options.clearTimers()
    state.phase.value = 'lobby'
    state.result.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = false
    state.winningPlayerIndex.value = -1
    state.matchFinished.value = false
    state.players.splice(0, state.players.length)
  }

  return { nextRound, returnToLobby }
}
