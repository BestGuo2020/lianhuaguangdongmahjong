// 「莲花麻将」用户操作控制器：把 UI 事件（选牌/出牌/碰/吃/杠/胡/过/抢杠）转换为
// HumanController 的 resolve 或直接驱动回合/杠执行。
import { performDiscardGang, performPeng, type ActionContext } from '../../core/rules/actions'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import type { LotusHumanController } from './lotusControllers'
import type { LotusEndGameOptions, LotusGameState } from './lotusState'
import type { createLotusKong } from './lotusKong'
import type { createLotusTurnOrchestrator } from './lotusTurnOrchestrator'

interface LotusHumanOptions {
  state: LotusGameState
  humanController: LotusHumanController
  tableContext: ActionContext
  turnOrchestrator: ReturnType<typeof createLotusTurnOrchestrator>
  kong: ReturnType<typeof createLotusKong>
  getUser(): GamePlayer | undefined
  isUserTurn(): boolean
  canUserHu(): boolean
  getUserKongs(): TileType[]
  userHasWindKong(): boolean
  stopCountdown(): void
  startTurnCountdown(): void
  discardTile(playerIndex: number, handIndex: number): unknown
  beginTurn(playerIndex: number, options: { fromTail: true }): unknown
  endGame(winnerIndex: number, options?: LotusEndGameOptions): unknown
  announce(text: string, tone?: string): void
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): number
}

export function createLotusHuman(options: LotusHumanOptions) {
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
    if (humanController.hasPendingRobKong()) return humanController.resolveRobKongAction('pass')
    if (humanController.hasPendingHu()) return humanController.resolveHu('pass')
    if (humanController.hasPendingChi()) return humanController.resolveChiPass()
    if (humanController.hasPendingClaim()) return humanController.resolveClaimPass()
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
    else void options.kong.performConcealedKong(0, tile)
  }

  function userWindKong() {
    if (humanController.hasPendingTurn()) return humanController.resolveWindKong()
    if (!options.isUserTurn() || !options.userHasWindKong()) return
    state.userDrewThisTurn.value = false
    options.stopCountdown()
    void options.kong.performWindKong(0)
  }

  function userChi(chiIndex = 0) {
    if (humanController.hasPendingChi()) {
      const option = state.actionPrompt.value?.chiOptions?.[chiIndex]
      if (option) humanController.resolveChi(option)
      return
    }
    const prompt = state.actionPrompt.value
    if (prompt?.type !== 'chi') return
    const option = prompt.chiOptions?.[chiIndex]
    if (!option) return
    options.stopCountdown()
    options.turnOrchestrator.performChi(0, option, prompt.tile, prompt.from)
    state.actionPrompt.value = null
    state.userDrewThisTurn.value = false
    state.phase.value = 'discard'
    state.selectedIndex.value = -1
    options.startTurnCountdown()
  }

  function userHu() {
    if (humanController.hasPendingRobKong()) return humanController.resolveRobKongAction('win')
    if (humanController.hasPendingHu()) return humanController.resolveHu('win')
    if (humanController.hasPendingTurn()) return humanController.resolveWin()
    if (state.actionPrompt.value?.type === 'rob') {
      const kongPlayerIndex = state.pendingKong.value?.playerIndex ?? state.actionPrompt.value.from
      const winTile = state.actionPrompt.value.tile
      state.pendingKong.value = null
      return options.endGame(0, {
        robbedKong: true,
        robbedKongPlayerIndex: kongPlayerIndex,
        winTile,
        winHand: [...(options.getUser()?.hand ?? []), winTile],
      })
    }
    if (options.canUserHu()) {
      options.endGame(0, {
        selfDraw: true,
        kongBloom: options.turnOrchestrator.isKongDraw(0),
        winHand: [...(options.getUser()?.hand ?? [])],
      })
    }
  }

  return {
    selectTile, clearUserSelection, userDiscard, userPass, userPeng,
    userGangFromDiscard, userGang, userWindKong, userChi, userHu,
  }
}
