import { waitingTiles } from '../../core/rules/rules'
import { waitingTiles as lotusWaitingTiles } from '../../variants/lotus/lotusRules'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import type { RemoteGameState } from '../state/remoteGameState'

type ActionState = Pick<RemoteGameState, 'selectedIndex' | 'actionPrompt' | 'autoPlay' | 'rulesetId' | 'jokerTiles'>

export type RemotePlayerActionMessage =
  | { type: 'discard'; handIndex: number; requestId?: string }
  | { type: 'pass'; requestId?: string }
  | { type: 'claim'; action: 'peng' | 'gang' | 'chi'; optionIndex?: number; requestId?: string }
  | { type: 'gang'; kind: 'added' | 'concealed' | 'wind'; tile?: TileType; requestId?: string }
  | { type: 'hu'; requestId?: string }

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

/**
 * 弃牌响应提示类型：wire 客户端收到的是 'claim'（requestCoordinator 设置），
 * 房主 viewer 的提示来自引擎桥（LotusHumanController.requestDiscardHu → 'response'）。
 * 两者的按钮完全一致，动作守卫必须同时接受，否则房主「胡/吃/碰/杠」按钮点了没反应
 * （只有不检查类型的「过」能用）。
 */
function isClaimPrompt(prompt: { type?: string } | null | undefined): boolean {
  return prompt?.type === 'claim' || prompt?.type === 'response'
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
      // 莲花麻将按精牌/白板算听口；经典规则用无精的 waitingTiles。
      const waits = state.rulesetId.value === 'lotus-legacy'
        ? lotusWaitingTiles(afterDiscard, meldCount, state.jokerTiles.value).length
        : waitingTiles(afterDiscard, meldCount).length
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
    if (!prompt) return
    playSound('click.mp3', 0.65)
    send({ type: 'pass' })
  }

  function userPeng() {
    if (!isClaimPrompt(state.actionPrompt.value)) return
    clearCountdown()
    playSound('click.mp3', 0.65)
    send({ type: 'claim', action: 'peng' })
  }

  function userChi(optionIndex = 0) {
    if (!isClaimPrompt(state.actionPrompt.value) || !state.actionPrompt.value.chiOptions?.[optionIndex]) return
    clearCountdown()
    playSound('click.mp3', 0.65)
    send({ type: 'claim', action: 'chi', optionIndex })
  }

  function userGangFromDiscard() {
    if (!isClaimPrompt(state.actionPrompt.value) || !state.actionPrompt.value.canGang) return
    clearCountdown()
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

  function userWindKong() {
    clearCountdown()
    playSound('click.mp3', 0.65)
    send({ type: 'gang', kind: 'wind' })
  }

  function userHu() {
    if (isClaimPrompt(state.actionPrompt.value) && state.actionPrompt.value.canHu) {
      clearCountdown()
      playSound('click.mp3', 0.65)
      send({ type: 'hu' })
      return
    }
    if (state.actionPrompt.value?.type === 'rob') {
      clearCountdown()
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
    userChi,
    userGangFromDiscard,
    userGang,
    userWindKong,
    userHu,
  }
}
