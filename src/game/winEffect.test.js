import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from './useGame'
import { splitWinningTile, WIN_DISPLAY_LAYOUTS } from './winEffect'

function installTimerWindow() {
  const timers = []
  vi.stubGlobal('window', {
    matchMedia: vi.fn(() => ({ matches: false })),
    clearInterval: vi.fn(),
    setInterval: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    setTimeout: vi.fn((callback, delay) => {
      const id = timers.length + 1
      timers.push({ id, callback, delay })
      return id
    }),
  })
  return timers
}

afterEach(() => vi.unstubAllGlobals())

describe('胡牌展示位', () => {
  it('四家使用约定的方向', () => {
    expect(WIN_DISPLAY_LAYOUTS.map((layout) => layout.rotation)).toEqual([
      0,
      Math.PI / 2,
      Math.PI,
      -Math.PI / 2,
    ])
  })

  it('自摸从手牌中抽出胡牌张，展示区保留一张', () => {
    const hand = ['m1', 'east', 'p2', 'east']
    const split = splitWinningTile(hand, {
      tile: 'east',
      sourceIndex: 3,
      robbedKong: false,
    })

    expect(split.hand).toEqual(['m1', 'east', 'p2'])
    expect(split.displayTile).toBe('east')
    expect(split.removedIndex).toBe(3)
    expect(hand).toHaveLength(4)
  })

  it('抢杠胡不删除赢家手牌，只增加外部胡牌张', () => {
    const hand = ['m1', 'east', 'p2']
    const split = splitWinningTile(hand, {
      tile: 'east',
      sourceIndex: -1,
      robbedKong: true,
    })

    expect(split.hand).toEqual(hand)
    expect(split.displayTile).toBe('east')
    expect(split.removedIndex).toBe(-1)
  })
})

describe('胡牌演出流程', () => {
  it('自摸经过特效和摊牌后保留独立展示牌', () => {
    const timers = installTimerWindow()
    const game = useGame()

    game.debugPreviewWin(1)

    expect(game.phase.value).toBe('win-effect')
    expect(game.winPresentation.value).toMatchObject({
      winnerIndex: 1,
      tile: 'east',
      sourceIndex: 13,
      robbedKong: false,
    })
    expect(splitWinningTile(game.players[1].hand, game.winPresentation.value).hand).toHaveLength(13)

    timers.find((timer) => timer.delay === 2600).callback()
    expect(game.phase.value).toBe('revealing')
    expect(game.winEffect.value).toBeNull()
    expect(game.winPresentation.value?.tile).toBe('east')

    timers.find((timer) => timer.delay === 1500).callback()
    expect(game.phase.value).toBe('settled')
    expect(game.result.value?.winnerIndex).toBe(1)
  })

  it('抢杠胡完整保留十三张手牌，并把被抢牌放入展示位', () => {
    const timers = installTimerWindow()
    const game = useGame()

    game.debugPreviewWin(3, { robbedKong: true })

    expect(game.winPresentation.value).toMatchObject({
      winnerIndex: 3,
      tile: 'east',
      sourceIndex: -1,
      robbedKong: true,
    })
    expect(game.players[3].hand).toHaveLength(13)
    expect(splitWinningTile(game.players[3].hand, game.winPresentation.value).hand).toHaveLength(13)

    timers.find((timer) => timer.delay === 2600).callback()
    timers.find((timer) => timer.delay === 1500).callback()
    expect(game.phase.value).toBe('settled')
    expect(game.result.value).toMatchObject({ winnerIndex: 3, robbedKong: true })
  })
})
