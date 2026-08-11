import { describe, expect, it, vi } from 'vitest'
import { createLocalGameState } from './localGameState'
import { createLocalOpeningTimeline } from './localOpeningTimeline'

describe('localOpeningTimeline', () => {
  it('cancels an in-flight opening before dice and dealing mutate state', async () => {
    const state = createLocalGameState()
    let releaseWait!: () => void
    const timeline = createLocalOpeningTimeline({
      state,
      clearTimers: () => timeline.cancel(),
      takeTile: () => null,
      wait: () => new Promise<void>((resolve) => { releaseWait = resolve }),
      later: vi.fn(() => 1),
      playSound: vi.fn(),
      playSoundAndWait: async () => {},
      announce: vi.fn(),
      getRoundLabel: () => '东1局',
      beginTurn: vi.fn(),
      endGame: vi.fn(),
    })

    const opening = timeline.start('east')
    await Promise.resolve()
    expect(state.openingStage.value).toBe('start')

    timeline.cancel()
    releaseWait()
    await opening

    expect(state.openingStage.value).toBeNull()
    expect(state.diceValues.value).toEqual([1, 1])
  })
})
