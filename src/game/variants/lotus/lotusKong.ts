// 「莲花麻将」杠执行：暗杠 / 风杠（乱风杠）/ 加杠，杠分即时结算。
// 明杠（直杠）与碰复用 core/rules/actions 的 performDiscardGang / performPeng。
import type { ScoreDelta, TableActionType, TileType } from '../../core/contracts/types'
import { PACE_MS } from '../../core/local/localGameConfig'
import { applyKongScore } from './lotusScoring'
import type { LotusGameState } from './lotusState'
import { createKongActionExecutor } from '../../shared/runtime/kongActionExecutor'
import { sortTilesWithJokers } from '../../core/rules/tiles'
import { LOTUS_RULESET } from './lotusRules'
import type { RuleSet } from '../../core/rules/ruleset'
import { isLocalLlmSeat } from '../../core/presentation/localLlmVoiceRegistry'

const WIND_MELD_TILES: TileType[] = ['east', 'south', 'west', 'north']

interface LotusKongOptions {
  state: LotusGameState
  showTableAction(type: TableActionType, actorIndex: number, sourceIndex: number | null, tile: TileType, meldIndex: number): void
  showScoreFlow(deltas: ScoreDelta[]): void
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): number
  beginTurn(playerIndex: number, options: { fromTail: true }): unknown
  ruleset?: RuleSet
}

export function createLotusKong(options: LotusKongOptions) {
  const { state } = options
  const common = createKongActionExecutor({
    ...options,
    sortHand: (hand) => sortTilesWithJokers(hand, state.jokerTiles.value),
    scoreKong: (options.ruleset ?? LOTUS_RULESET).score.applyKongScore,
    addedKongDelay: PACE_MS.afterKongSettle,
  })

  /** 风杠（乱风杠）：东南西北各 1 张，按暗杠处理但亮明。 */
  async function performWindKong(playerIndex: number) {
    const player = state.players[playerIndex]
    WIND_MELD_TILES.forEach((wind) => {
      const index = player.hand.indexOf(wind)
      if (index >= 0) player.hand.splice(index, 1)
    })
    player.hand = sortTilesWithJokers(player.hand, state.jokerTiles.value)
    player.drawnTileIndex = -1
    player.melds.push({ type: 'angang', tile: 'east', tiles: [...WIND_MELD_TILES], windKong: true })
    const scoreDeltas = (options.ruleset ?? LOTUS_RULESET).score.applyKongScore(state.players, playerIndex, 'concealed')
    options.showTableAction('concealed-gang', playerIndex, null, 'east', player.melds.length - 1)
    options.showScoreFlow(scoreDeltas)
    if (!isLocalLlmSeat(playerIndex)) options.playSound('gang.mp3')
  }

  return { ...common, performWindKong }
}
