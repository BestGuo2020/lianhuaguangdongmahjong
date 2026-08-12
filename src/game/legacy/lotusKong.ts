// 「莲花麻将」杠执行：暗杠 / 风杠（乱风杠）/ 加杠，杠分即时结算。
// 明杠（直杠）与碰复用 core/rules/actions 的 performDiscardGang / performPeng。
import { removeMatches } from '../core/rules/actions'
import type { ScoreDelta, TableActionType, TileType } from '../core/contracts/types'
import { PACE_MS } from '../core/local/localGameConfig'
import { applyKongScore } from './lotusScoring'
import type { LotusGameState } from './lotusState'

const WIND_MELD_TILES: TileType[] = ['east', 'south', 'west', 'north']

interface LotusKongOptions {
  state: LotusGameState
  showTableAction(type: TableActionType, actorIndex: number, sourceIndex: number | null, tile: TileType, meldIndex: number): void
  showScoreFlow(deltas: ScoreDelta[]): void
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): number
  beginTurn(playerIndex: number, options: { fromTail: true }): unknown
}

export function createLotusKong(options: LotusKongOptions) {
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

  /** 风杠（乱风杠）：东南西北各 1 张，按暗杠处理但亮明。 */
  async function performWindKong(playerIndex: number) {
    const player = state.players[playerIndex]
    WIND_MELD_TILES.forEach((wind) => {
      const index = player.hand.indexOf(wind)
      if (index >= 0) player.hand.splice(index, 1)
    })
    player.drawnTileIndex = -1
    player.melds.push({ type: 'angang', tile: 'east', tiles: [...WIND_MELD_TILES], windKong: true })
    const scoreDeltas = applyKongScore(state.players, playerIndex, 'concealed')
    options.showTableAction('concealed-gang', playerIndex, null, 'east', player.melds.length - 1)
    options.showScoreFlow(scoreDeltas)
    options.playSound('gang.mp3')
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

  return { performConcealedKong, performWindKong, declareAddedKong, settleAddedKong }
}
