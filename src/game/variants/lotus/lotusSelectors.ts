import { computed } from 'vue'
import { TILE_TYPES } from '../../core/rules/tiles'
import { MATCH_NAMES } from '../../core/local/localGameConfig'
import { createCommonGameSelectors, createRulePlayerSelectors, structuralMeldCount } from '../../shared/selectors/gameSelectors'
import { matchingCount, windKong, LOTUS_RULESET } from './lotusRules'
import type { RuleSet } from '../../core/rules/ruleset'
import type { LotusGameState } from './lotusState'

export { structuralMeldCount }

export function createLotusSelectors(state: LotusGameState, ruleset: RuleSet = LOTUS_RULESET) {
  const common = createCommonGameSelectors(state, MATCH_NAMES)
  const playerSelectors = createRulePlayerSelectors({
    players: state.players,
    user: common.user,
    phase: state.phase,
    isUserTurn: common.isUserTurn,
    userDrewThisTurn: state.userDrewThisTurn,
    selectedIndex: state.selectedIndex,
    availableWaitTiles: () => TILE_TYPES.filter((tile) => !state.jokerTiles.value.includes(tile)),
    isWinningHand: (hand, meldCount) => ruleset.win.isWinningHand(hand, meldCount, { jokers: state.jokerTiles.value, jokerSubstitutes: state.wildcardTiles.value }),
    concealedKongs: (hand) => ruleset.win.concealedKongs(hand, { jokers: state.jokerTiles.value }),
    waitingTiles: (hand, meldCount) => ruleset.win.waitingTiles(hand, meldCount, { jokers: state.jokerTiles.value, jokerSubstitutes: state.wildcardTiles.value }),
    matchingCount,
  })
  const userHasWindKong = computed(() => Boolean(common.user.value)
    && common.isUserTurn.value
    && state.userDrewThisTurn.value
    && windKong(common.user.value!.hand, state.jokerTiles.value))
  return { ...common, ...playerSelectors, userHasWindKong }
}
