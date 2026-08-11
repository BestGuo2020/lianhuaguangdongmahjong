import type { EndGameOptions, GamePlayer, TileType } from '../contracts/types'
import type { HumanController } from '../controllers/playerController'
import { performDiscardGang, performPeng, type ActionContext } from '../rules/actions'
import type { LocalGameState } from './localGameState'
import type { createLocalKongActionExecutor } from './localKongActionExecutor'
import type { createLocalTurnOrchestrator } from './localTurnOrchestrator'

interface LocalPlayerActionControllerOptions {
  state: LocalGameState
  humanController: HumanController
  tableContext: ActionContext
  turnOrchestrator: ReturnType<typeof createLocalTurnOrchestrator>
  kongActionExecutor: ReturnType<typeof createLocalKongActionExecutor>
  getUser(): GamePlayer | undefined
  isUserTurn(): boolean
  canUserHu(): boolean
  getUserKongs(): TileType[]
  stopCountdown(): void
  startTurnCountdown(): void
  discardTile(playerIndex: number, handIndex: number): unknown
  beginTurn(playerIndex: number, options: { fromTail: true }): unknown
  endGame(winnerIndex: number, options?: EndGameOptions): unknown
  announce(text: string, tone?: string): void
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): number
}

export function createLocalPlayerActionController(options: LocalPlayerActionControllerOptions) {
  const { state, humanController } = options

  function selectTile(index: number) {
    if (!options.isUserTurn()) return
    state.selectedIndex.value = index
    options.playSound('click.mp3', 0.65)
  }

  function clearUserSelection() {
    state.selectedIndex.value = -1
  }

  function userDiscard(index = state.selectedIndex.value) {
    if (humanController.hasPendingTurn()) return humanController.resolveDiscard(index)
    const user = options.getUser()
    if (!user || !options.isUserTurn() || index < 0 || index >= user.hand.length) return
    clearUserSelection()
    options.discardTile(0, index)
  }

  function userPass() {
    const prompt = state.actionPrompt.value
    options.stopCountdown()
    state.actionPrompt.value = null
    if (!prompt) return
    options.playSound('click.mp3', 0.65)
    if (prompt.type === 'rob') {
      if (humanController.hasPendingRobKong()) return humanController.resolveRobKongAction('pass')
      const kong = state.pendingKong.value
      if (!kong) return
      const nextRobber = kong.remainingRobbers[0]
      if (nextRobber !== undefined) {
        state.pendingKong.value = null
        options.announce(`${state.players[nextRobber].name} 抢杠胡`, 'red')
        options.later(() => {
          options.endGame(nextRobber, {
            robbedKong: true,
            robbedKongPlayerIndex: kong.playerIndex,
            winTile: kong.tile,
          })
        }, 450)
        return
      }
      state.pendingKong.value = null
      options.kongActionExecutor.settleAddedKong(kong.playerIndex)
      return
    }
    if (humanController.hasPendingClaim()) return humanController.resolveClaimPass()
    void options.turnOrchestrator.offerNextClaim(prompt.remainingClaims ?? [], prompt.tile, prompt.from)
  }

  function userPeng() {
    if (humanController.hasPendingClaim()) return humanController.resolveClaimPeng()
    const prompt = state.actionPrompt.value
    if (prompt?.type !== 'claim') return
    options.stopCountdown()
    performPeng(options.tableContext, 0, prompt.tile, prompt.from)
    state.actionPrompt.value = null
    state.userDrewThisTurn.value = false
    state.phase.value = 'discard'
    state.selectedIndex.value = -1
    options.startTurnCountdown()
  }

  function userGangFromDiscard() {
    if (humanController.hasPendingClaim()) return humanController.resolveClaimGang()
    const prompt = state.actionPrompt.value
    if (prompt?.type !== 'claim' || !prompt.canGang) return
    options.stopCountdown()
    performDiscardGang(options.tableContext, 0, prompt.tile, prompt.from)
    state.actionPrompt.value = null
    state.userDrewThisTurn.value = false
    options.later(() => { options.beginTurn(0, { fromTail: true }) }, 350)
  }

  function userGang(tile = options.getUserKongs()[0]) {
    const user = options.getUser()
    if (!tile || !user) return
    if (humanController.hasPendingTurn()) {
      const meldIndex = user.melds.findIndex((meld) => meld.type === 'peng' && meld.tile === tile)
      return meldIndex >= 0
        ? humanController.resolveAddedKong(meldIndex)
        : humanController.resolveConcealedKong(tile)
    }
    if (!options.isUserTurn()) return
    state.userDrewThisTurn.value = false
    options.stopCountdown()
    const meldIndex = user.melds.findIndex((meld) => meld.type === 'peng' && meld.tile === tile)
    if (meldIndex >= 0) options.turnOrchestrator.requestAddedKong(0, meldIndex, tile)
    else void options.kongActionExecutor.performConcealedKong(0, tile)
  }

  function userHu() {
    if (humanController.hasPendingRobKong()) return humanController.resolveRobKongAction('win')
    if (humanController.hasPendingTurn()) return humanController.resolveWin()
    if (state.actionPrompt.value?.type === 'rob') {
      const kongPlayerIndex = state.pendingKong.value?.playerIndex ?? state.actionPrompt.value.from
      const winTile = state.actionPrompt.value.tile
      state.pendingKong.value = null
      return options.endGame(0, { robbedKong: true, robbedKongPlayerIndex: kongPlayerIndex, winTile })
    }
    if (options.canUserHu()) {
      options.endGame(0, { kongBloom: options.turnOrchestrator.isKongDraw(0) })
    }
  }

  return {
    selectTile, clearUserSelection, userDiscard, userPass, userPeng,
    userGangFromDiscard, userGang, userHu,
  }
}
