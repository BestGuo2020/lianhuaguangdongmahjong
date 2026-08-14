import type { GamePhase, RefLike } from '../contracts/gamePort'
import type { GamePlayer, TileType } from '../contracts/types'
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
  /** 响应式规则集 getter（莲花麻将在 rejoin_ok 后才确定 rulesetId，故需惰性读取）。 */
  getRuleset?: () => RuleSet | undefined
  /** 动态癞子（精）getter；莲花麻将传入，经典省略。 */
  getJokers?: () => readonly TileType[]
  /** 可替代精牌的实体牌 getter（白板）。 */
  getWildcards?: () => readonly TileType[]
}

export function createPlayerSelectors(options: PlayerSelectorOptions) {
  const ruleset = () => options.getRuleset?.() ?? options.ruleset ?? DEFAULT_RULESET
  const jokers = () => options.getJokers?.() ?? []
  const wildcards = () => options.getWildcards?.() ?? []
  return createRulePlayerSelectors({
    ...options,
    // 经典排除花牌红中；莲花麻将按精牌动态排除。
    availableWaitTiles: () => TILE_TYPES.filter((tile) => (
      ruleset().id === 'lotus-legacy'
        ? !jokers().includes(tile)
        : tile !== 'red'
    )),
    isWinningHand: (hand, meldCount) => ruleset().win.isWinningHand(hand, meldCount, { jokers: jokers(), jokerSubstitutes: wildcards() }),
    concealedKongs: (hand) => ruleset().win.concealedKongs(hand, { jokers: jokers() }),
    waitingTiles: (hand, meldCount) => ruleset().win.waitingTiles(hand, meldCount, { jokers: jokers(), jokerSubstitutes: wildcards() }),
    matchingCount,
  })
}
