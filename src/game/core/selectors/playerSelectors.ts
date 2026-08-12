import type { GamePhase, RefLike } from '../contracts/gamePort'
import type { GamePlayer } from '../contracts/types'
import { concealedKongs, isWinningHand, matchingCount, waitingTiles } from '../rules/rules'
import { TILE_TYPES } from '../rules/tiles'
import { createRulePlayerSelectors, structuralMeldCount } from '../../shared/selectors/gameSelectors'

export { structuralMeldCount }

export interface PlayerSelectorOptions {
  players: GamePlayer[]
  user: RefLike<GamePlayer | undefined>
  phase: RefLike<GamePhase>
  isUserTurn: RefLike<boolean>
  userDrewThisTurn: RefLike<boolean>
  selectedIndex: RefLike<number>
}

export function createPlayerSelectors(options: PlayerSelectorOptions) {
  return createRulePlayerSelectors({
    ...options,
    availableWaitTiles: () => TILE_TYPES.filter((tile) => tile !== 'red'),
    isWinningHand,
    concealedKongs,
    waitingTiles,
    matchingCount,
  })
}
