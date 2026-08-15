import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from '../../core/local/useGame'
import { AiController, type PlayerController } from '../../core/controllers/playerController'
import type { ServerSnapshot } from '../protocol/dto'
import type { ServerMessage } from '../protocol/messages'
import { startHostGame } from './hostGameRunner'
import { createMockVibeRoom } from './mockVibeRoom'

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

describe('startHostGame 无头权威', () => {
  it('开局广播 round_start，并把 seat0 快照喂给 onLocalSnapshot', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const snapshots: ServerSnapshot[] = []
    const events: ServerMessage[] = []
    const runner = startHostGame<PlayerController>({
      room,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map(),
      createController: () => ({}) as PlayerController,
      createGame: (controllers) => useGame({
        remoteControllers: controllers,
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      onLocalSnapshot: (snapshot) => snapshots.push(snapshot),
      onLocalEvent: (message) => events.push(message),
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(events.some((event) => event.kind === 'round_start')).toBe(true)
    expect(snapshots.some((snapshot) => snapshot.seat === 0 && snapshot.players.length === 4)).toBe(true)
    // 无头引擎：开局后即时进入回合（不等 PACE_MS/发牌动画）。
    expect(runner.game.phase.value).not.toBe('lobby')
    runner.stop()
  })

  it('玩家摸牌瞬间广播「已摸牌（14 张 + drawnTileIndex）」快照，其余玩家可见摸上来的牌', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const snapshots: ServerSnapshot[] = []
    const runner = startHostGame<PlayerController>({
      room,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map(),
      createController: () => ({}) as PlayerController,
      // 全 AI 控制器：headless 下 seat 0 默认为 HumanController（无人操作会卡住庄家回合），
      // 测试需要对局自动推进到有人摸牌。
      createGame: () => useGame({
        controllers: [
          new AiController(), new AiController(), new AiController(), new AiController(),
        ],
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      onLocalSnapshot: (snapshot) => snapshots.push(snapshot),
      onLocalEvent: () => {},
    })

    // 推进对局直到出现「摸牌中」快照：某家手牌 14 张且 drawnTileIndex >= 0。
    // 回归：drawFor 把牌推入手牌后、phase 切到 thinking（广播被守卫拦截）之前，
    // 房主必须补发一次快照，否则其余玩家永远看不到摸上来的第 14 张。
    let drawn: ServerSnapshot | undefined
    for (let i = 0; i < 400; i += 1) {
      await vi.advanceTimersByTimeAsync(50)
      drawn = snapshots.find((snapshot) => snapshot.players.some(
        (player) => player.hand.length >= 14 && player.drawnTileIndex >= 0,
      ))
      if (drawn) break
    }
    expect(drawn).toBeTruthy()
    runner.stop()
  })
})
