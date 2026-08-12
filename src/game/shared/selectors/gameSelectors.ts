import { computed } from 'vue'
import type { GamePhase, RefLike, WaitInfo } from '../../core/contracts/gamePort'
import type { GamePlayer, MatchType, TileType } from '../../core/contracts/types'

export function structuralMeldCount(player: GamePlayer) {
  return player.melds.filter((meld) => meld.type !== 'flower').length
}

interface CommonSelectorState {
  players: GamePlayer[]
  phase: RefLike<GamePhase>
  currentPlayer: RefLike<number>
  wall: RefLike<TileType[]>
  round: RefLike<number>
  matchType: RefLike<MatchType>
}

export function createCommonGameSelectors(state: CommonSelectorState, matchNames: Record<MatchType, string>) {
  const user = computed(() => state.players[0])
  const isUserTurn = computed(() => state.currentPlayer.value === 0 && state.phase.value === 'discard')
  const wallCount = computed(() => state.wall.value.length)
  const windName = computed(() => (state.round.value > 4 ? '南' : '东'))
  const handNumber = computed(() => ((state.round.value - 1) % 4) + 1)
  const roundLabel = computed(() => `${windName.value}${handNumber.value}局`)
  const matchName = computed(() => matchNames[state.matchType.value])
  const standings = computed(() => state.players
    .map((player, index) => ({ ...player, playerIndex: index }))
    .sort((a, b) => b.score - a.score || a.playerIndex - b.playerIndex)
    .map((player, index) => ({ ...player, rank: index + 1 })))
  return { user, isUserTurn, wallCount, roundLabel, matchName, standings }
}

interface RuleSelectorOptions {
  players: GamePlayer[]
  user: RefLike<GamePlayer | undefined>
  phase: RefLike<GamePhase>
  isUserTurn: RefLike<boolean>
  userDrewThisTurn: RefLike<boolean>
  selectedIndex: RefLike<number>
  availableWaitTiles: () => TileType[]
  isWinningHand: (hand: TileType[], meldCount: number) => boolean
  concealedKongs: (hand: TileType[]) => TileType[]
  waitingTiles: (hand: TileType[], meldCount: number) => TileType[]
  matchingCount: (tiles: TileType[], tile: TileType) => number
}

export function createRulePlayerSelectors(options: RuleSelectorOptions) {
  const { players, user, phase, isUserTurn, userDrewThisTurn, selectedIndex } = options
  const userCanHu = computed(() => Boolean(user.value) && isUserTurn.value && userDrewThisTurn.value
    && options.isWinningHand(user.value!.hand, structuralMeldCount(user.value!)))
  const userKongs = computed(() => {
    if (!user.value || !isUserTurn.value || !userDrewThisTurn.value) return []
    const concealed = options.concealedKongs(user.value.hand)
    const added = user.value.melds
      .filter((meld) => meld.type === 'peng' && user.value!.hand.includes(meld.tile))
      .map((meld) => meld.tile)
    return [...new Set([...concealed, ...added])]
  })
  function visibleRemainingCount(tile: TileType) {
    let visible = options.matchingCount(user.value?.hand ?? [], tile)
    players.forEach((player) => {
      visible += options.matchingCount(player.discards, tile)
      player.melds.forEach((meld) => { visible += options.matchingCount(meld.tiles, tile) })
    })
    return Math.max(0, 4 - visible)
  }
  function makeWaitInfo(waits: TileType[], discard: TileType | null = null): WaitInfo | null {
    if (!waits.length) return null
    const tiles = waits.map((tile) => ({ tile, remaining: visibleRemainingCount(tile) }))
    return {
      discard,
      tiles,
      any: waits.length === options.availableWaitTiles().length,
      remaining: tiles.reduce((total, item) => total + item.remaining, 0),
    }
  }
  function discardWaitInfo(handIndex: number) {
    if (!user.value) return null
    const handAfterDiscard = user.value.hand.filter((_, index) => index !== handIndex)
    return makeWaitInfo(options.waitingTiles(handAfterDiscard, structuralMeldCount(user.value)), user.value.hand[handIndex])
  }
  const userCurrentWaits = computed(() => {
    if (!user.value || ['lobby', 'dealing', 'settled'].includes(phase.value)) return null
    return makeWaitInfo(options.waitingTiles(user.value.hand, structuralMeldCount(user.value)))
  })
  const userTingOptions = computed(() => {
    if (!user.value || !isUserTurn.value) return []
    const seen = new Set<TileType>()
    return user.value.hand.flatMap((tile, index) => {
      if (seen.has(tile)) return []
      seen.add(tile)
      const info = discardWaitInfo(index)
      return info ? [info] : []
    })
  })
  const userDiscardWaits = computed(() => {
    if (selectedIndex.value < 0) return null
    const selectedTile = user.value?.hand[selectedIndex.value]
    return userTingOptions.value.find((option) => option.discard === selectedTile) ?? null
  })
  return { userCanHu, userKongs, userCurrentWaits, userTingOptions, userDiscardWaits }
}
