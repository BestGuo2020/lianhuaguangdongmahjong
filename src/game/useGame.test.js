import { describe, expect, it, vi } from 'vitest'
import { useGame } from './useGame'

function player(hand = []) {
  return {
    name: '测试玩家',
    score: 1000,
    hand,
    discards: [],
    melds: [],
    redCount: 0,
    drawnTileIndex: -1,
  }
}

describe('玩家操作阶段限制', () => {
  it('碰牌后即使牌型可胡且留有第四张，也只允许出牌', () => {
    vi.stubGlobal('window', {
      clearInterval: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      setTimeout: vi.fn(() => 1),
    })

    const game = useGame()
    game.players.push(
      player([
        'm1', 'm1', 'm1', 'm2', 'm3',
        'p4', 'p5', 'p6',
        's7', 's7', 's7',
        'east', 'east',
      ]),
      player(), player(), player(),
    )
    game.players[1].discards.push('m1')
    game.actionPrompt.value = {
      type: 'claim', tile: 'm1', from: 1, canGang: true, remainingClaims: [],
    }

    game.userPeng()

    expect(game.isUserTurn.value).toBe(true)
    expect(game.userCanHu.value).toBe(false)
    expect(game.userKongs.value).toEqual([])
    vi.unstubAllGlobals()
  })
})
