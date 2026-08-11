import { describe, expect, it, vi } from 'vitest'
import { useGame } from './useGame'
import { advanceMatchState, resolveWinTile } from './matchProgress'
import type { GamePlayer, TileType } from '../contracts/types'

describe('match progression', () => {
  it('continues the match when a player has a negative score', () => {
    const next = advanceMatchState({
      round: 1,
      dealer: 0,
      honba: 0,
      matchType: 'east',
      result: { draw: false, winnerIndex: 1 },
      scores: [-100, 2100, 1000, 1000],
    })

    expect(next).toEqual({ round: 2, dealer: 1, honba: 0, finished: false })
  })
})

describe('opening deal sound', () => {
  it('plays once per four-tile batch and skips single-tile batches', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    })
    const playSound = vi.fn<(name: string, volume?: number, onFinish?: () => void) => void>()
    const playSoundAndWait = vi.fn<(name: string, volume?: number) => Promise<void>>(async () => {})
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

function player(hand: TileType[] = [], seat = 0): GamePlayer {
  return {
    name: '测试玩家',
    avatar: '',
    score: 1000,
    seat,
    hand,
    discards: [],
    melds: [],
    redCount: 0,
    drawnTileIndex: -1,
  }
}

describe('四红中胡牌展示', () => {
  it('固定使用第 4 张红中，而不是此前摸到的手牌', () => {
    const winner = player(['m1', 'white'])
    winner.drawnTileIndex = 1
    winner.redCount = 4

    expect(resolveWinTile(winner, { fourRed: true })).toBe('red')
  })
})

describe('玩家操作阶段限制', () => {
  it('选择牌不再自动出牌，显式出牌可按指定索引执行', () => {
    vi.stubGlobal('window', {
      clearInterval: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      setTimeout: vi.fn(() => 1),
    })
    const game = useGame()
    game.players.push(player(['m1', 'm2']), player([], 1), player([], 2), player([], 3))
    game.currentPlayer.value = 0
    game.phase.value = 'discard'

    game.selectTile(0)
    game.selectTile(0)
    expect(game.players[0].hand).toEqual(['m1', 'm2'])

    game.userDiscard(0)
    expect(game.players[0].hand).toEqual(['m2'])
    expect(game.players[0].discards).toEqual(['m1'])
    vi.unstubAllGlobals()
  })

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
      player([], 1), player([], 2), player([], 3),
    )
    game.players[1].discards.push('m1')
    game.actionPrompt.value = {
      type: 'claim', tile: 'm1', from: 1, canGang: true, remainingClaims: [],
    }

    game.userPeng()

    expect(game.isUserTurn.value).toBe(true)
    expect(game.userCanHu.value).toBe(false)
    expect(game.userKongs.value).toEqual([])
    expect(game.tableActionEvent.value).toMatchObject({
      type: 'peng', actorIndex: 0, sourceIndex: 1, tile: 'm1', meldIndex: 0,
    })
    expect(game.announcement.value).toBeNull()
    vi.unstubAllGlobals()
  })

  it('点杠同时生成一收一付的座位飘分', () => {
    vi.stubGlobal('window', {
      clearInterval: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      setTimeout: vi.fn(() => 1),
    })
    const game = useGame()
    game.players.push(
      player(['m1', 'm1', 'm1', 'm2']),
      player([], 1),
      player([], 2),
      player([], 3),
    )
    game.players[2].discards.push('m1')
    game.actionPrompt.value = {
      type: 'claim', tile: 'm1', from: 2, canGang: true, remainingClaims: [],
    }

    game.userGangFromDiscard()

    expect(game.scoreFlowEvent.value?.deltas).toEqual([
      { playerIndex: 0, amount: 100 },
      { playerIndex: 2, amount: -100 },
    ])
    expect(game.players.map((item) => item.score)).toEqual([1100, 1000, 900, 1000])
    vi.unstubAllGlobals()
  })

  it('补杠先把第四张牌加入副露并报杠，再处理抢杠', () => {
    const setTimeout = vi.fn<(callback: () => void, delay?: number) => number>(() => 1)
    vi.stubGlobal('window', {
      clearInterval: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      setTimeout,
    })
    const playSound = vi.fn<(name: string, volume?: number, onFinish?: () => void) => void>()
    const game = useGame({ playSound })
    game.players.push(
      { ...player(['east', 'm1']), melds: [{ type: 'peng', tile: 'east', from: 1, tiles: ['east', 'east', 'east'] }] },
      player(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east'], 1),
      player([], 2), player([], 3),
    )
    game.currentPlayer.value = 0
    game.phase.value = 'discard'

    game.userGang('east')

    expect(game.players[0].hand).not.toContain('east')
    expect(game.players[0].melds[0]).toMatchObject({
      type: 'gang', added: true, pending: true, tiles: ['east', 'east', 'east', 'east'],
    })
    expect(game.tableActionEvent.value).toMatchObject({
      type: 'added-gang', actorIndex: 0, sourceIndex: null, tile: 'east', meldIndex: 0,
    })
    expect(game.announcement.value).toBeNull()
    expect(game.actionPrompt.value).toBeNull()
    expect(playSound).toHaveBeenCalledWith('gang.mp3')
    expect(game.players.map((item) => item.score)).toEqual([1000, 1000, 1000, 1000])
    expect(setTimeout.mock.calls.some(([, delay]) => delay === 650)).toBe(true)
    vi.unstubAllGlobals()
  })
})

describe('胡牌座位提示', () => {
  function createWinPreview() {
    vi.stubGlobal('window', {
      clearInterval: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      setTimeout: vi.fn(() => 1),
      matchMedia: vi.fn(() => ({ matches: false })),
    })
    return useGame()
  }

  it('自摸提示绑定赢家座位', () => {
    const game = createWinPreview()
    game.debugPreviewWin(2)
    expect(game.tableActionEvent.value).toMatchObject({
      type: 'self-draw', actorIndex: 2, sourceIndex: null, tile: 'east', meldIndex: -1,
    })
    vi.unstubAllGlobals()
  })

  it('抢杠胡提示绑定赢家，并保留被抢杠玩家来源', () => {
    const game = createWinPreview()
    game.debugPreviewWin(1, { robbedKong: true })
    expect(game.tableActionEvent.value).toMatchObject({
      type: 'robbed-kong-win', actorIndex: 1, sourceIndex: 0, tile: 'east', meldIndex: -1,
    })
    vi.unstubAllGlobals()
  })
})

describe('越界弃牌索引（回归：clamp 到末张，不卡死）', () => {
  const badDiscard = {
    requestTurn: async () => ({ kind: 'discard' as const, handIndex: 99 }),
    requestClaim: async () => ({ kind: 'pass' as const }),
    requestRobKong: async () => 'pass' as const,
    onDiscarded: () => {},
    reset: () => {},
  }

  it('AI 返回越界弃牌索引时 clamp 到末张，对局正常推进到流局（不卡在弃牌）', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    })
    const game = useGame({
      controllers: [badDiscard, badDiscard, badDiscard, badDiscard],
      playSound: () => {},
      playSoundAndWait: async () => {},
    })
    const startPromise = game.startGame('east')
    let steps = 0
    while (!game.matchFinished.value && game.phase.value !== 'settled' && steps < 300) {
      steps += 1
      await vi.advanceTimersByTimeAsync(1000)
    }
    // 未卡死：对局推进到流局/结算（若无 clamp，首家越界弃牌会永久停在弃牌阶段）
    expect(game.phase.value).toBe('settled')
    expect(steps).toBeLessThan(300)
    await startPromise
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
})
