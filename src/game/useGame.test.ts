import { describe, expect, it, vi } from 'vitest'
import { useGame } from './useGame'

describe('opening deal sound', () => {
  it('plays once per four-tile batch and skips single-tile batches', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    })
    const playSound = vi.fn()
    const playSoundAndWait = vi.fn(async () => {})
    const game = useGame({ playSound, playSoundAndWait })

    const startPromise = game.startGame('east')
    await vi.advanceTimersByTimeAsync(7000)
    await startPromise

    const dealCalls = playSound.mock.calls.filter(([name]) => name === 'deal.mp3')
    expect(dealCalls).toHaveLength(12)
    expect(dealCalls.every(([, volume]) => volume === 0.72)).toBe(true)
    expect(playSoundAndWait).not.toHaveBeenCalledWith('deal.mp3', expect.anything())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})

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

  it('补杠先把第四张牌加入副露并报杠，再处理抢杠', () => {
    const setTimeout = vi.fn(() => 1)
    vi.stubGlobal('window', {
      clearInterval: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      setTimeout,
    })
    const playSound = vi.fn()
    const game = useGame({ playSound })
    game.players.push(
      { ...player(['east', 'm1']), melds: [{ type: 'peng', tile: 'east', from: 1, tiles: ['east', 'east', 'east'] }] },
      player(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east']),
      player(), player(),
    )
    game.currentPlayer.value = 0
    game.phase.value = 'discard'

    game.userGang('east')

    expect(game.players[0].hand).not.toContain('east')
    expect(game.players[0].melds[0]).toMatchObject({
      type: 'gang', added: true, pending: true, tiles: ['east', 'east', 'east', 'east'],
    })
    expect(game.announcement.value?.text).toBe('杠')
    expect(game.actionPrompt.value).toBeNull()
    expect(playSound).toHaveBeenCalledWith('gang.mp3')
    expect(game.players.map((item) => item.score)).toEqual([1000, 1000, 1000, 1000])
    expect(setTimeout.mock.calls.some(([, delay]) => delay === 650)).toBe(true)
    vi.unstubAllGlobals()
  })
})
