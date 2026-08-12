import { computed } from 'vue'
import { TILE_TYPES } from '../../core/rules/tiles'
import { MATCH_NAMES } from '../../core/local/localGameConfig'
import { createCommonGameSelectors, createRulePlayerSelectors, structuralMeldCount } from '../../shared/selectors/gameSelectors'
import { concealedKongs, isWinningHand, matchingCount, waitingTiles, windKong } from './lotusRules'
import type { LotusGameState } from './lotusState'

export { structuralMeldCount }

export function createLotusSelectors(state: LotusGameState) {
  const common = createCommonGameSelectors(state, MATCH_NAMES)
  const playerSelectors = createRulePlayerSelectors({
    players: state.players,
    user: common.user,
    phase: state.phase,
    isUserTurn: common.isUserTurn,
    userDrewThisTurn: state.userDrewThisTurn,
    selectedIndex: state.selectedIndex,
    availableWaitTiles: () => TILE_TYPES.filter((tile) => !state.jokerTiles.value.includes(tile)),
    isWinningHand: (hand, meldCount) => isWinningHand(hand, meldCount, state.jokerTiles.value),
    concealedKongs: (hand) => concealedKongs(hand, state.jokerTiles.value),
    waitingTiles: (hand, meldCount) => waitingTiles(hand, meldCount, state.jokerTiles.value),
    matchingCount,
  })
  const userHasWindKong = computed(() => Boolean(common.user.value)
    && common.isUserTurn.value
    && state.userDrewThisTurn.value
    && windKong(common.user.value!.hand, state.jokerTiles.value))
  return { ...common, ...playerSelectors, userHasWindKong }
}
