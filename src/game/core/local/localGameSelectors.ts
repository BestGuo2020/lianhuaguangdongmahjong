import { MATCH_NAMES } from './localGameConfig'
import type { LocalGameState } from './localGameState'
import { createPlayerSelectors, structuralMeldCount } from '../selectors/playerSelectors'
import { createCommonGameSelectors } from '../../shared/selectors/gameSelectors'

export { structuralMeldCount }

export function createLocalGameSelectors(state: LocalGameState) {
  const common = createCommonGameSelectors(state, MATCH_NAMES)
  const playerSelectors = createPlayerSelectors({
    players: state.players,
    user: common.user,
    phase: state.phase,
    isUserTurn: common.isUserTurn,
    userDrewThisTurn: state.userDrewThisTurn,
    selectedIndex: state.selectedIndex,
  })
  return { ...common, ...playerSelectors }
}
