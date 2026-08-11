import { waitingTiles } from '../../core/rules/rules'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import type { RemoteGameState } from '../state/remoteGameState'

type ActionState = Pick<RemoteGameState, 'selectedIndex' | 'actionPrompt' | 'autoPlay'>

export type RemotePlayerActionMessage =
  | { type: 'discard'; handIndex: number }
  | { type: 'pass' }
  | { type: 'claim'; action: 'peng' | 'gang' }
  | { type: 'gang'; kind: 'added' | 'concealed'; tile: TileType }
  | { type: 'hu' }

export interface RemoteActionControllerOptions {
  state: ActionState
  isUserTurn(): boolean
  canUserHu(): boolean
  getUser(): GamePlayer | undefined
  getUserKongs(): TileType[]
  clearCountdown(): void
  playSound(name: string, volume?: number): unknown
  send(message: RemotePlayerActionMessage): void
}

function structuralMeldCount(player: GamePlayer): number {
  return player.melds.filter((meld) => meld.type !== 'flower').length
}

export function createRemoteActionController({
  state,
  isUserTurn,
  canUserHu,
  getUser,
  getUserKongs,
  clearCountdown,
  playSound,
  send,
}: RemoteActionControllerOptions) {
  function selectTile(index: number) {
    if (!isUserTurn()) return
    state.selectedIndex.value = index
    playSound('click.mp3', 0.65)
  }

  function clearUserSelection() {
    state.selectedIndex.value = -1
  }

  function userDiscard(index = state.selectedIndex.value) {
    const user = getUser()
    if (!user || !isUserTurn() || index < 0 || index >= user.hand.length) return
    clearCountdown()
    clearUserSelection()
    send({ type: 'discard', handIndex: index })
  }

  function pickDiscard(): number {
    const user = getUser()
    const hand = user?.hand ?? []
    if (!user || !hand.length) return -1
    const meldCount = structuralMeldCount(user)
    let bestIndex = hand.length - 1
    let bestWaits = -1
    const seen = new Set<TileType>()
    for (let index = 0; index < hand.length; index += 1) {
      const tile = hand[index]
      if (seen.has(tile)) continue
      seen.add(tile)
      const afterDiscard = hand.filter((_, candidate) => candidate !== index)
      const waits = waitingTiles(afterDiscard, meldCount).length
      if (waits > bestWaits) {
        bestWaits = waits
        bestIndex = index
      }
    }
    return bestIndex
  }

  function toggleAutoPlay() {
    state.autoPlay.value = !state.autoPlay.value
  }

  function userPass() {
    const prompt = state.actionPrompt.value
    clearCountdown()
    state.actionPrompt.value = null
    if (!prompt) return
    playSound('click.mp3', 0.65)
    send({ type: 'pass' })
  }

  function userPeng() {
    if (state.actionPrompt.value?.type !== 'claim') return
    clearCountdown()
    state.actionPrompt.value = null
    playSound('click.mp3', 0.65)
    send({ type: 'claim', action: 'peng' })
  }

  function userGangFromDiscard() {
    if (state.actionPrompt.value?.type !== 'claim' || !state.actionPrompt.value.canGang) return
    clearCountdown()
    state.actionPrompt.value = null
    playSound('click.mp3', 0.65)
    send({ type: 'claim', action: 'gang' })
  }

  function userGang(tile = getUserKongs()[0]) {
    const user = getUser()
    if (!tile || !user || !isUserTurn()) return
    clearCountdown()
    playSound('click.mp3', 0.65)
    const hasPengMeld = user.melds.some((meld) => meld.type === 'peng' && meld.tile === tile)
    send({ type: 'gang', kind: hasPengMeld ? 'added' : 'concealed', tile })
  }

  function userHu() {
    if (state.actionPrompt.value?.type === 'rob') {
      clearCountdown()
      state.actionPrompt.value = null
      playSound('click.mp3', 0.65)
      send({ type: 'hu' })
      return
    }
    if (!canUserHu()) return
    clearCountdown()
    send({ type: 'hu' })
  }

  return {
    selectTile,
    clearUserSelection,
    userDiscard,
    pickDiscard,
    toggleAutoPlay,
    userPass,
    userPeng,
    userGangFromDiscard,
    userGang,
    userHu,
  }
}
