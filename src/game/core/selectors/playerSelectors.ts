import { computed } from 'vue'
import type { GamePhase, RefLike, WaitInfo } from '../contracts/gamePort'
import type { GamePlayer, TileType } from '../contracts/types'
import { concealedKongs, isWinningHand, matchingCount, waitingTiles } from '../rules/rules'
import { TILE_TYPES } from '../rules/tiles'

export function structuralMeldCount(player: GamePlayer) {
  return player.melds.filter((meld) => meld.type !== 'flower').length
}

export interface PlayerSelectorOptions {
  players: GamePlayer[]
  user: RefLike<GamePlayer | undefined>
  phase: RefLike<GamePhase>
  isUserTurn: RefLike<boolean>
  userDrewThisTurn: RefLike<boolean>
  selectedIndex: RefLike<number>
}

export function createPlayerSelectors(options: PlayerSelectorOptions) {
  const { players, user, phase, isUserTurn, userDrewThisTurn, selectedIndex } = options

  const userCanHu = computed(() => Boolean(user.value)
    && isUserTurn.value
    && userDrewThisTurn.value
    && isWinningHand(user.value!.hand, structuralMeldCount(user.value!)))

  const userKongs = computed(() => {
    if (!user.value || !isUserTurn.value || !userDrewThisTurn.value) return []
    const concealed = concealedKongs(user.value.hand)
    const added = user.value.melds
      .filter((meld) => meld.type === 'peng' && user.value!.hand.includes(meld.tile))
      .map((meld) => meld.tile)
    return [...new Set([...concealed, ...added])]
  })

  function visibleRemainingCount(tile: TileType) {
    let visible = matchingCount(user.value?.hand ?? [], tile)
    players.forEach((player) => {
      visible += matchingCount(player.discards, tile)
      player.melds.forEach((meld) => { visible += matchingCount(meld.tiles, tile) })
    })
    return Math.max(0, 4 - visible)
  }

  function makeWaitInfo(waits: TileType[], discard: TileType | null = null): WaitInfo | null {
    if (!waits.length) return null
    const tiles = waits.map((tile) => ({ tile, remaining: visibleRemainingCount(tile) }))
    const allTiles = TILE_TYPES.filter((tile) => tile !== 'red')
    return {
      discard,
      tiles,
      any: waits.length === allTiles.length,
      remaining: tiles.reduce((total, item) => total + item.remaining, 0),
    }
  }

  function discardWaitInfo(handIndex: number) {
    if (!user.value) return null
    const handAfterDiscard = user.value.hand.filter((_, index) => index !== handIndex)
    return makeWaitInfo(
      waitingTiles(handAfterDiscard, structuralMeldCount(user.value)),
      user.value.hand[handIndex],
    )
  }

  const userCurrentWaits = computed(() => {
    if (!user.value || ['lobby', 'dealing', 'settled'].includes(phase.value)) return null
    return makeWaitInfo(waitingTiles(user.value.hand, structuralMeldCount(user.value)))
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
