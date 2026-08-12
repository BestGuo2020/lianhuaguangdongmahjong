// 「莲花麻将」选择器：用户能否胡/杠、听牌信息等，全部基于本局癞子集合判定。
import { computed } from 'vue'
import type { WaitInfo } from '../core/contracts/gamePort'
import type { TileType } from '../core/contracts/types'
import { TILE_TYPES } from '../core/rules/tiles'
import { structuralMeldCount } from '../core/selectors/playerSelectors'
import { MATCH_NAMES } from '../core/local/localGameConfig'
import {
  concealedKongs,
  isWinningHand,
  matchingCount,
  waitingTiles,
  windKong,
} from './lotusRules'
import type { LotusGameState } from './lotusState'

export { structuralMeldCount }

export function createLotusSelectors(state: LotusGameState) {
  const user = computed(() => state.players[0])
  const isUserTurn = computed(() => state.currentPlayer.value === 0 && state.phase.value === 'discard')

  const userCanHu = computed(() => Boolean(user.value)
    && isUserTurn.value
    && state.userDrewThisTurn.value
    && isWinningHand(user.value!.hand, structuralMeldCount(user.value!), state.jokerTiles.value))

  const userKongs = computed(() => {
    if (!user.value || !isUserTurn.value || !state.userDrewThisTurn.value) return []
    const concealed = concealedKongs(user.value.hand, state.jokerTiles.value)
    const added = user.value.melds
      .filter((meld) => meld.type === 'peng' && user.value!.hand.includes(meld.tile))
      .map((meld) => meld.tile)
    return [...new Set([...concealed, ...added])]
  })

  const userHasWindKong = computed(() => Boolean(user.value)
    && isUserTurn.value
    && state.userDrewThisTurn.value
    && windKong(user.value.hand, state.jokerTiles.value))

  const wallCount = computed(() => state.wall.value.length)
  const windName = computed(() => (state.round.value > 4 ? '南' : '东'))
  const handNumber = computed(() => ((state.round.value - 1) % 4) + 1)
  const roundLabel = computed(() => `${windName.value}${handNumber.value}局`)
  const matchName = computed(() => MATCH_NAMES[state.matchType.value])
  const standings = computed(() => state.players
    .map((player, index) => ({ ...player, playerIndex: index }))
    .sort((a, b) => b.score - a.score || a.playerIndex - b.playerIndex)
    .map((player, index) => ({ ...player, rank: index + 1 })))

  function visibleRemainingCount(tile: TileType) {
    let visible = matchingCount(user.value?.hand ?? [], tile)
    state.players.forEach((player) => {
      visible += matchingCount(player.discards, tile)
      player.melds.forEach((meld) => { visible += matchingCount(meld.tiles, tile) })
    })
    return Math.max(0, 4 - visible)
  }

  function makeWaitInfo(waits: TileType[], discard: TileType | null = null): WaitInfo | null {
    if (!waits.length) return null
    const tiles = waits.map((tile) => ({ tile, remaining: visibleRemainingCount(tile) }))
    const allTiles = TILE_TYPES.filter((tile) => !state.jokerTiles.value.includes(tile))
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
      waitingTiles(handAfterDiscard, structuralMeldCount(user.value), state.jokerTiles.value),
      user.value.hand[handIndex],
    )
  }

  const userCurrentWaits = computed(() => {
    if (!user.value || ['lobby', 'dealing', 'settled'].includes(state.phase.value)) return null
    return makeWaitInfo(waitingTiles(user.value.hand, structuralMeldCount(user.value), state.jokerTiles.value))
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
    if (state.selectedIndex.value < 0) return null
    const selectedTile = user.value?.hand[state.selectedIndex.value]
    return userTingOptions.value.find((option) => option.discard === selectedTile) ?? null
  })

  return {
    user,
    isUserTurn,
    userCanHu,
    userKongs,
    userHasWindKong,
    wallCount,
    roundLabel,
    matchName,
    standings,
    userCurrentWaits,
    userTingOptions,
    userDiscardWaits,
  }
}
