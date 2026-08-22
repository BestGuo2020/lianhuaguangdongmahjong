import type { RefLike } from '../../core/contracts/gamePort'
import type { GamePhase } from '../../core/contracts/gamePort'
import type { GamePlayer, ScoreDelta, TableActionType, TileType } from '../../core/contracts/types'
import { removeMatches } from '../../core/rules/actions'
import { isLocalLlmSeat } from '../../core/presentation/localLlmVoiceRegistry'

interface KongState {
  players: GamePlayer[]
  phase: RefLike<GamePhase>
}

interface KongActionExecutorOptions {
  state: KongState
  sortHand?: (hand: TileType[]) => TileType[]
  scoreKong(players: GamePlayer[], playerIndex: number, kind: 'concealed' | 'added'): ScoreDelta[]
  showTableAction(type: TableActionType, actorIndex: number, sourceIndex: number | null, tile: TileType, meldIndex: number): void
  showScoreFlow(deltas: ScoreDelta[]): void
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): number
  beginTurn(playerIndex: number, options: { fromTail: true }): unknown
  addedKongDelay: number
}

export function createKongActionExecutor(options: KongActionExecutorOptions) {
  const { state } = options
  async function performConcealedKong(
    playerIndex: number,
    tile: TileType,
    { noContinue = false }: { noContinue?: boolean } = {},
  ) {
    const player = state.players[playerIndex]
    if (!player || player.hand.filter((item) => item === tile).length < 4) return
    player.hand = removeMatches(player.hand, tile, 4)
    if (options.sortHand) player.hand = options.sortHand(player.hand)
    player.drawnTileIndex = -1
    player.melds.push({ type: 'angang', tile, tiles: [tile, tile, tile, tile] })
    options.showTableAction('concealed-gang', playerIndex, null, tile, player.melds.length - 1)
    options.showScoreFlow(options.scoreKong(state.players, playerIndex, 'concealed'))
    if (!isLocalLlmSeat(playerIndex)) options.playSound('gang.mp3')
    if (!noContinue) options.later(() => { options.beginTurn(playerIndex, { fromTail: true }) }, 350)
  }
  function declareAddedKong(playerIndex: number, meldIndex: number, tile: TileType) {
    const player = state.players[playerIndex]
    const meld = player?.melds[meldIndex]
    if (!player || !meld || meld.type !== 'peng' || meld.tile !== tile || !player.hand.includes(tile)) return
    player.hand = removeMatches(player.hand, tile, 1)
    if (options.sortHand) player.hand = options.sortHand(player.hand)
    player.drawnTileIndex = -1
    player.melds[meldIndex] = {
      ...player.melds[meldIndex], type: 'gang', added: true, pending: true,
      tile, tiles: [tile, tile, tile, tile],
    }
    state.phase.value = 'kong'
    options.showTableAction('added-gang', playerIndex, null, tile, meldIndex)
    if (!isLocalLlmSeat(playerIndex)) options.playSound('gang.mp3')
  }
  function settleAddedKong(playerIndex: number) {
    const player = state.players[playerIndex]
    const meld = player.melds.find((item) => item.type === 'gang' && item.added && item.pending)
    if (meld) meld.pending = false
    options.showScoreFlow(options.scoreKong(state.players, playerIndex, 'added'))
    options.later(() => { options.beginTurn(playerIndex, { fromTail: true }) }, options.addedKongDelay)
  }
  return { performConcealedKong, declareAddedKong, settleAddedKong }
}
