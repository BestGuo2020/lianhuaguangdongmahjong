import type { RoundResult } from '../contracts/gamePort'
import type { EndGameOptions, GamePlayer, MatchType } from '../contracts/types'
import { MATCH_HANDS } from './localGameConfig'

type MatchProgressResult = Pick<RoundResult, 'draw' | 'winnerIndex' | 'dealerTenpai'>

export function resolveWinTile(winner: GamePlayer, options: EndGameOptions = {}) {
  if (options.fourRed) return 'red' as const
  return options.winTile
    ?? winner.hand[winner.drawnTileIndex]
    ?? winner.hand[winner.hand.length - 1]
}

export function advanceMatchState({ round, dealer, honba, matchType, result, playerCount = 4 }: {
  round: number
  dealer: number
  honba: number
  matchType: MatchType
  result: MatchProgressResult
  scores?: number[]
  playerCount?: number
}) {
  const dealerKeepsSeat = (!result.draw && result.winnerIndex === dealer)
    || (result.draw && result.dealerTenpai)
  const next = dealerKeepsSeat
    ? { round, dealer, honba: honba + 1 }
    : { round: round + 1, dealer: (dealer + 1) % playerCount, honba: 0 }
  return {
    ...next,
    finished: next.round > MATCH_HANDS[matchType],
  }
}
