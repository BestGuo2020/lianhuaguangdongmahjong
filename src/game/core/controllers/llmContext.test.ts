// llmContext 构建器单元测试：局况/可见牌/请求版本（docs/llm-ai-design.md §6.2 / §11 任务 1.1）。
import { describe, expect, it } from 'vitest'
import { createLocalGameState } from '../local/localGameState'
import { createLlmContextSource, stateVersionOf } from './llmContext'
import type { GamePlayer, TileType } from '../contracts/types'

function player(seat: number, hand: TileType[] = [], discards: TileType[] = []): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000 + seat * 100, seat,
    hand, discards, melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

describe('llmContext meta builder', () => {
  it('exposes 局况、请求标识与状态指纹', () => {
    const state = createLocalGameState()
    state.players.push(player(0, ['m1', 'm2']), player(1), player(2), player(3))
    state.dealer.value = 0
    state.round.value = 2
    state.phase.value = 'thinking'
    state.wall.value = ['s1', 's2']
    state.wallHeadDrawn.value = 52
    state.currentPlayer.value = 1

    const llm = createLlmContextSource(state, { jokerTiles: () => ['white'] })
    const meta = llm.meta(1, 'turn')

    expect(meta.scores).toEqual([1000, 1100, 1200, 1300])
    expect(meta.dealerIndex).toBe(0)
    expect(meta.roundIndex).toBe(2)
    expect(meta.wallCount).toBe(2)
    // 庄家在 0 座：座位 1 = 南；东风场恒为东
    expect(meta.seatWind).toBe('南')
    expect(meta.roundWind).toBe('东')
    expect(meta.requestId).toBe('turn-1-1')
    expect(meta.stateVersion).toBe('2:thinking:2:52:1:2')
    expect(meta.jokerTiles).toEqual(['white'])
    expect(meta.wildcardTiles).toEqual([])
  })

  it('requestId 单调递增；claim 指示牌位', () => {
    const state = createLocalGameState()
    state.players.push(player(0), player(1), player(2), player(3))
    const llm = createLlmContextSource(state, { jokerTiles: () => ['white'] })
    expect(llm.meta(0, 'turn').requestId).toBe('turn-0-1')
    expect(llm.meta(2, 'claim').requestId).toBe('claim-2-2')
    expect(llm.meta(3, 'turn').requestId).toBe('turn-3-3')
  })

  it('座位风随庄家旋转；半庄场后 4 局为南', () => {
    const state = createLocalGameState()
    state.players.push(player(0), player(1), player(2), player(3))
    state.dealer.value = 1
    state.matchType.value = 'hanchan'
    state.round.value = 5
    const llm = createLlmContextSource(state, { jokerTiles: () => [] })
    // 庄家 1 座：座位 0 = 北、座位 2 = 南（对齐 tableLayout.windForSeat 旋转）
    expect(llm.meta(0, 'turn').seatWind).toBe('北')
    expect(llm.meta(2, 'turn').seatWind).toBe('南')
    expect(llm.meta(0, 'turn').roundWind).toBe('南')
  })

  it('可见牌：己方含手牌+副露+弃牌；他人仅公开弃牌/副露', () => {
    const state = createLocalGameState()
    state.players.push(
      player(0, ['m1', 'm2'], ['p1']),
      player(1, ['s9'], ['s8']),
      player(2), player(3),
    )
    state.players[0].melds.push({ type: 'peng', tile: 'east', tiles: ['east', 'east', 'east'] })

    const llm = createLlmContextSource(state, { jokerTiles: () => ['white'] })
    const meta = llm.meta(0, 'turn')
    expect(meta.visibleTiles).toContain('m1')
    expect(meta.visibleTiles).toContain('east')
    expect(meta.visibleTiles).toContain('p1')
    // 他人手牌不进入可见牌
    expect(meta.visibleTiles).not.toContain('s9')
    expect(meta.publicTiles).toEqual(expect.arrayContaining(['p1', 's8', 'east']))
    expect(meta.publicTiles).not.toContain('m1')
    expect(meta.publicTiles).not.toContain('s9')
  })

  it('上家刚打牌跟随提示：取上家最后弃牌；无则 null', () => {
    const state = createLocalGameState()
    state.players.push(player(0, [], ['m5', 'm6']), player(1, [], []), player(2, [], ['p9']), player(3))
    const llm = createLlmContextSource(state, { jokerTiles: () => ['white'] })
    // 座位 1 的上家是座位 0：最后弃牌 m6
    expect(llm.meta(1, 'claim').upperLastDiscard).toBe('m6')
    // 座位 2 的上家是座位 1：无弃牌
    expect(llm.meta(2, 'claim').upperLastDiscard).toBeNull()
  })

  it('stateVersion 随摸牌/弃牌状态变化', () => {
    const state = createLocalGameState()
    state.players.push(player(0, ['m1'], ['p1']), player(1), player(2), player(3))
    state.wall.value = ['s1']
    state.wallHeadDrawn.value = 52
    const before = stateVersionOf(state)
    state.players[0].hand.push('m3')          // 摸牌
    state.wall.value = []
    state.wallHeadDrawn.value = 53
    expect(stateVersionOf(state)).not.toBe(before)
    state.phase.value = 'settled'
    expect(stateVersionOf(state)).toMatch(/settled/)
  })

  it('莲花选项：翻精/替代牌面分别注入', () => {
    const state = createLocalGameState()
    state.players.push(player(0), player(1), player(2), player(3))
    const llm = createLlmContextSource(state, {
      jokerTiles: () => ['m5', 'm6'],
      wildcardTiles: () => ['white'],
    })
    const meta = llm.meta(0, 'turn')
    expect(meta.jokerTiles).toEqual(['m5', 'm6'])
    expect(meta.wildcardTiles).toEqual(['white'])
  })
})
