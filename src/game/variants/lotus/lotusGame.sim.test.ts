import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLotusGame, type LotusGame } from './lotusGame'

// 整局模拟：用假定时器驱动完整对局（3 个 AI 玩家自动行动、0 号人类座位由倒计时
// 自动出牌/自动过牌），验证莲花麻将闭环能稳定打完：不卡死、分数守恒。

function stubWindow() {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * 牌数守恒（莲花麻将）：翻精墩整体移出牌墙（2 张），其余 134 张在
 * 「牌墙 + 各家手牌 + 各家副露 + 各家弃牌」间流转，总数恒为 134。
 * 该不变量对碰/吃/杠/抢杠都成立，能捕获牌的重复/丢失。
 */
function checkTileConservation(game: LotusGame) {
  const wall = game.wall.value.length
  const hands = game.players.reduce((sum, player) => sum + player.hand.length, 0)
  const melds = game.players.reduce(
    (sum, player) => sum + player.melds.reduce((m, meld) => m + (meld.tiles?.length ?? 0), 0),
    0,
  )
  const discards = game.players.reduce((sum, player) => sum + player.discards.length, 0)
  const inPlay = wall + hands + melds + discards
  const winningDisplay = game.winPresentation.value?.discardWin ? 1 : 0
  expect(inPlay + winningDisplay, `牌数不守恒: wall=${wall} hands=${hands} melds=${melds} discards=${discards} win=${winningDisplay}`).toBe(134)
  game.players.forEach((player) => {
    expect(player.hand.length).toBeLessThanOrEqual(20)
  })
}

async function playOneMatch(maxSteps = 8000) {
  const game = useLotusGame({ playSound: () => {}, playSoundAndWait: async () => {} })
  const startPromise = game.startGame('east')
  const settledRounds: string[] = []
  let steps = 0
  while (steps < maxSteps) {
    steps += 1
    if (game.matchFinished.value || game.phase.value === 'finished') break
    if (game.phase.value === 'settled') {
      settledRounds.push(String(game.round.value))
      checkTileConservation(game)
      game.nextRound()
      continue
    }
    if (game.phase.value === 'lobby') break
    await vi.advanceTimersByTimeAsync(1000)
  }
  await startPromise
  return {
    finished: game.matchFinished.value || game.phase.value === 'finished',
    steps,
    phase: game.phase.value,
    round: game.round.value,
    settledRounds,
    scores: game.players.map((player) => ({ name: player.name, score: player.score })),
  }
}

describe('莲花麻将整局模拟：东风场自动打完', () => {
  it('连续 3 场对局都能打完且无异常', async () => {
    stubWindow()
    for (let match = 1; match <= 3; match += 1) {
      const result = await playOneMatch()
      expect(result.finished).toBe(true)
      expect(result.settledRounds.length).toBeGreaterThan(0)
      // 分数守恒：4 名玩家起始各 2000，任意时刻总和应为 8000
      expect(result.scores.reduce((sum, player) => sum + player.score, 0)).toBe(8000)
    }
  }, 120_000)

  it('单人场在固定步数内能到达结算或打完，不出死循环', async () => {
    stubWindow()
    const result = await playOneMatch()
    expect(result.steps).toBeLessThan(8000)
    expect(result.phase === 'finished' || result.phase === 'settled').toBe(true)
  }, 120_000)
})
