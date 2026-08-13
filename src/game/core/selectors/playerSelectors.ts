import type { GamePhase, RefLike } from '../contracts/gamePort'
import type { GamePlayer } from '../contracts/types'
import { matchingCount } from '../rules/rules'
import { TILE_TYPES } from '../rules/tiles'
import { createRulePlayerSelectors, structuralMeldCount } from '../../shared/selectors/gameSelectors'
import { DEFAULT_RULESET, type RuleSet } from '../rules/ruleset'

export { structuralMeldCount }

export interface PlayerSelectorOptions {
  players: GamePlayer[]
  user: RefLike<GamePlayer | undefined>
  phase: RefLike<GamePhase>
  isUserTurn: RefLike<boolean>
  userDrewThisTurn: RefLike<boolean>
  selectedIndex: RefLike<number>
  ruleset?: RuleSet
}

export function createPlayerSelectors(options: PlayerSelectorOptions) {
  return createRulePlayerSelectors({
    ...options,
    availableWaitTiles: () => TILE_TYPES.filter((tile) => tile !== 'red'),
    isWinningHand: (hand, meldCount) => (options.ruleset ?? DEFAULT_RULESET).win.isWinningHand(hand, meldCount),
    concealedKongs: (hand) => (options.ruleset ?? DEFAULT_RULESET).win.concealedKongs(hand),
    waitingTiles: (hand, meldCount) => (options.ruleset ?? DEFAULT_RULESET).win.waitingTiles(hand, meldCount),
    matchingCount,
  })
}
