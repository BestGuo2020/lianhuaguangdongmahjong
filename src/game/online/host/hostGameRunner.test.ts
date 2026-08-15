import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from '../../core/local/useGame'
import type { PlayerController } from '../../core/controllers/playerController'
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
})
