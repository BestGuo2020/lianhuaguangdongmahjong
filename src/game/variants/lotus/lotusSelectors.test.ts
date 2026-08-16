import { describe, expect, it } from 'vitest'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import { TILE_TYPES } from '../../core/rules/tiles'
import { waitingTiles } from './lotusRules'
import { createLotusSelectors } from './lotusSelectors'
import { createLotusGameState } from './lotusState'

function player(seat: number, hand: TileType[] = []): GamePlayer {
  return {
    name: `player-${seat}`,
    avatar: '',
    score: 2000,
    seat,
    hand,
    discards: [],
    melds: [],
    redCount: 0,
    drawnTileIndex: -1,
  }
}

describe('莲花麻将听牌提示', () => {
  it('听任意（34 种全胡）时 any=true，提示显示「听任意」（与广麻一致）', () => {
    const state = createLotusGameState()
    state.jokerTiles.value = ['m3', 'm4']
    state.wildcardTiles.value = ['white']
    state.phase.value = 'discard'
    state.players.push(
      // 3 顺 + 东刻 + 单白板（替身）：补入任意牌都能成胡（精面补入即增加癞子数）
      player(0, ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east', 'east', 'white']),
      player(1),
      player(2),
      player(3),
    )
    // 前置：这手牌确实「听任意」——34 种候选全部能胡。
    expect(waitingTiles(state.players[0].hand, 0, ['m3', 'm4'], ['white'])).toHaveLength(TILE_TYPES.length)
    const selectors = createLotusSelectors(state)
    expect(selectors.userCurrentWaits.value?.any).toBe(true)
  })

  it('非全听时不显示「听任意」（any=false）', () => {
    const state = createLotusGameState()
    state.jokerTiles.value = ['m3', 'm4']
    state.wildcardTiles.value = ['white']
    state.phase.value = 'discard'
    state.players.push(
      // 单骑听 east：只有 east 与精面可补
      player(0, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east']),
      player(1),
      player(2),
      player(3),
    )
    const selectors = createLotusSelectors(state)
    expect(selectors.userCurrentWaits.value?.any).toBe(false)
    expect(selectors.userCurrentWaits.value?.tiles.length).toBeGreaterThan(0)
  })
})
