import { computed } from 'vue'
import { MATCH_NAMES } from './localGameConfig'
import type { LocalGameState } from './localGameState'
import { createPlayerSelectors, structuralMeldCount } from '../selectors/playerSelectors'

export { structuralMeldCount }

export function createLocalGameSelectors(state: LocalGameState) {
  const user = computed(() => state.players[0])
  const isUserTurn = computed(() => state.currentPlayer.value === 0 && state.phase.value === 'discard')
  const playerSelectors = createPlayerSelectors({
    players: state.players,
    user,
    phase: state.phase,
    isUserTurn,
    userDrewThisTurn: state.userDrewThisTurn,
    selectedIndex: state.selectedIndex,
  })
  const wallCount = computed(() => state.wall.value.length)
  const windName = computed(() => (state.round.value > 4 ? '南' : '东'))
  const handNumber = computed(() => ((state.round.value - 1) % 4) + 1)
  const roundLabel = computed(() => `${windName.value}${handNumber.value}局`)
  const matchName = computed(() => MATCH_NAMES[state.matchType.value])
  const standings = computed(() => state.players
    .map((player, index) => ({ ...player, playerIndex: index }))
    .sort((a, b) => b.score - a.score || a.playerIndex - b.playerIndex)
    .map((player, index) => ({ ...player, rank: index + 1 })))

  return {
    user, isUserTurn, ...playerSelectors, wallCount, roundLabel, matchName, standings,
  }
}
