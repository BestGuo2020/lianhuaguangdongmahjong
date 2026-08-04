import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from './useGame'

// 整局模拟：用假定时器驱动完整对局（3 个 AI 玩家自动行动、0 号人类座位
// 由倒计时自动出牌/自动过牌），验证游戏闭环能稳定打完，不卡死、不抛错。

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
 * 打满一整场「东风场」。
 * 注意：若 AI 回合内的异步动作（如 playAITurn 内部）抛出未捕获异常，
 * vitest 默认会把 unhandledRejection 判为测试失败，无需额外检测。
 */
async function playOneMatch(maxSteps = 8000) {
  const game = useGame({ playSound: () => {}, playSoundAndWait: async () => {} })
  const startPromise = game.startGame('east')
  const settledRounds: string[] = []
  let steps = 0
  while (steps < maxSteps) {
    steps += 1
    if (game.matchFinished.value || game.phase.value === 'finished') break
    if (game.phase.value === 'settled') {
      settledRounds.push(String(game.round.value))
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

describe('整局模拟：东风场自动打完', () => {
  it('连续 3 场对局都能打完且无异常', async () => {
    stubWindow()
    for (let match = 1; match <= 3; match += 1) {
      const result = await playOneMatch()
      // 每场必须完整打到「finished」，证明 AI 闭环不会卡死
      expect(result.finished).toBe(true)
      // 每场至少完成一局才证明闭环在运转
      expect(result.settledRounds.length).toBeGreaterThan(0)
      // 分数守恒：4 名玩家起始各 1000，任意时刻总和应为 4000
      expect(result.scores.reduce((sum, player) => sum + player.score, 0)).toBe(4000)
    }
  }, 120_000)

  it('单人场在固定步数内能到达结算或打完，不出死循环', async () => {
    stubWindow()
    const result = await playOneMatch()
    expect(result.steps).toBeLessThan(8000)
    expect(result.phase === 'finished' || result.phase === 'settled').toBe(true)
  })
})
