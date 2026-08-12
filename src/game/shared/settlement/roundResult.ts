import type { RoundResult } from '../../core/contracts/gamePort'
import type { GamePlayer } from '../../core/contracts/types'

interface RoundResultContext {
  players: GamePlayer[]
  roundLabel: string
  honba: number
}

export function makeRoundResult(
  context: RoundResultContext,
  base: RoundResult,
  scoresBefore: number[],
): RoundResult {
  const ranking = context.players
    .map((player, playerIndex) => ({ playerIndex, score: player.score }))
    .sort((a, b) => b.score - a.score || a.playerIndex - b.playerIndex)
  const ranks = new Map(ranking.map((item, index) => [item.playerIndex, index + 1]))
  return {
    ...base,
    roundLabel: context.roundLabel,
    honba: context.honba,
    scoreChanges: context.players.map((player, playerIndex) => ({
      playerIndex,
      name: player.name,
      avatar: player.avatar,
      score: player.score,
      delta: player.score - scoresBefore[playerIndex],
      rank: ranks.get(playerIndex),
    })),
  }
}
