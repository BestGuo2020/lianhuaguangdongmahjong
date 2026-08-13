import { MATCH_NAMES } from './localGameConfig'
import type { LocalGameState } from './localGameState'
import { createPlayerSelectors, structuralMeldCount } from '../selectors/playerSelectors'
import { createCommonGameSelectors } from '../../shared/selectors/gameSelectors'
import { DEFAULT_RULESET, type RuleSet } from '../rules/ruleset'

export { structuralMeldCount }

export function createLocalGameSelectors(state: LocalGameState, ruleset: RuleSet = DEFAULT_RULESET) {
  const common = createCommonGameSelectors(state, MATCH_NAMES)
  const playerSelectors = createPlayerSelectors({
    players: state.players,
    user: common.user,
    phase: state.phase,
    isUserTurn: common.isUserTurn,
    userDrewThisTurn: state.userDrewThisTurn,
    selectedIndex: state.selectedIndex,
    ruleset,
  })
  return { ...common, ...playerSelectors }
}
