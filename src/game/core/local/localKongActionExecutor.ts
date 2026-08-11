import type { TileType } from '../contracts/types'
import { removeMatches } from '../rules/actions'
import { applyKongScore } from '../rules/rules'
import { PACE_MS } from './localGameConfig'
import type { LocalGameState } from './localGameState'

interface LocalKongActionExecutorOptions {
  state: LocalGameState
  showTableAction(
    type: 'concealed-gang' | 'added-gang',
    actorIndex: number,
    sourceIndex: number | null,
    tile: TileType,
    meldIndex: number,
  ): void
  showScoreFlow(deltas: Array<{ playerIndex: number; amount: number }>): void
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): number
  beginTurn(playerIndex: number, options: { fromTail: true }): unknown
}

export function createLocalKongActionExecutor(options: LocalKongActionExecutorOptions) {
  const { state } = options

  async function performConcealedKong(
    playerIndex: number,
    tile: TileType,
    { noContinue = false }: { noContinue?: boolean } = {},
  ) {
    const player = state.players[playerIndex]
    player.hand = removeMatches(player.hand, tile, 4)
    player.drawnTileIndex = -1
    player.melds.push({ type: 'angang', tile, tiles: [tile, tile, tile, tile] })
    const scoreDeltas = applyKongScore(state.players, playerIndex, 'concealed')
    options.showTableAction('concealed-gang', playerIndex, null, tile, player.melds.length - 1)
    options.showScoreFlow(scoreDeltas)
    options.playSound('gang.mp3')
    if (!noContinue) {
      options.later(() => { options.beginTurn(playerIndex, { fromTail: true }) }, 350)
    }
  }

  function declareAddedKong(playerIndex: number, meldIndex: number, tile: TileType) {
    const player = state.players[playerIndex]
    player.hand = removeMatches(player.hand, tile, 1)
    player.drawnTileIndex = -1
    player.melds[meldIndex] = {
      ...player.melds[meldIndex],
      type: 'gang',
      added: true,
      pending: true,
      tile,
      tiles: [tile, tile, tile, tile],
    }
    state.phase.value = 'kong'
    options.showTableAction('added-gang', playerIndex, null, tile, meldIndex)
    options.playSound('gang.mp3')
  }

  function settleAddedKong(playerIndex: number) {
    const player = state.players[playerIndex]
    const meld = player.melds.find((item) => item.type === 'gang' && item.added && item.pending)
    if (meld) meld.pending = false
    options.showScoreFlow(applyKongScore(state.players, playerIndex, 'added'))
    options.later(
      () => { options.beginTurn(playerIndex, { fromTail: true }) },
      PACE_MS.afterKongSettle,
    )
  }

  return { performConcealedKong, declareAddedKong, settleAddedKong }
}
