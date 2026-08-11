import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REDUCED_WIN_EFFECT_DURATION, REDUCED_WIN_REVEAL_DURATION } from '../../core/winEffect'
import type { ServerSnapshot } from '../protocol/dto'
import { createSettlementTimeline } from './settlementTimeline'

function snapshot(overrides: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    kind: 'state_snapshot', roomId: 'A', mode: 'east', phase: 'settled', round: 1,
    dealer: 0, honba: 0, wallCount: 0, wall: [], headDrawn: 0, currentPlayer: -1,
    players: [], seat: 2, announcement: null, matchFinished: false, lastDiscard: null,
    result: { winnerIndex: 2 }, winningPlayerIndex: 2,
    winPresentation: {
      winnerIndex: 2, tile: 'm1', sourceIndex: -1, robbedKong: false,
      robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1,
    },
    ...overrides,
  }
}

function harness() {
  const state = {
    phase: ref('playing'), result: ref<any>(null), winEffect: ref<any>(null),
    winPresentation: ref<any>(null), revealHands: ref(false), winningPlayerIndex: ref(-1),
  }
  const sounds: string[] = []
  const timeline = createSettlementTimeline({
    state,
    mapResult: (value) => value ? { ...value, winnerIndex: 0 } : null,
    mapPresentation: (value) => value ? { ...value, winnerIndex: 0 } : null,
    toLocalSeat: (seat) => (seat - 2 + 4) % 4,
    playSound: (name) => sounds.push(name),
    reducedMotion: () => true,
  })
  return { state, sounds, timeline }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('settlementTimeline', () => {
  it('runs win effect, reveal and settlement in order', async () => {
    const { state, sounds, timeline } = harness()
    timeline.start(snapshot())

    expect(state.phase.value).toBe('win-effect')
    expect(state.winningPlayerIndex.value).toBe(0)
    expect(sounds).toEqual(['zimo.mp3'])

    await vi.advanceTimersByTimeAsync(REDUCED_WIN_EFFECT_DURATION)
    expect(state.phase.value).toBe('revealing')
    expect(state.winEffect.value).toBeNull()
    expect(state.revealHands.value).toBe(true)

    await vi.advanceTimersByTimeAsync(REDUCED_WIN_REVEAL_DURATION)
    expect(state.phase.value).toBe('settled')
    expect(state.result.value?.winnerIndex).toBe(0)
  })

  it('uses the short reveal path for a draw', async () => {
    const { state, timeline } = harness()
    timeline.start(snapshot({ result: { draw: true }, winPresentation: null, winningPlayerIndex: -1 }))

    expect(state.phase.value).toBe('revealing')
    await vi.advanceTimersByTimeAsync(600)
    expect(state.phase.value).toBe('settled')
    expect(state.result.value?.draw).toBe(true)
  })

  it('cancels pending settlement transitions', async () => {
    const { state, timeline } = harness()
    timeline.start(snapshot())
    timeline.cancel()
    await vi.advanceTimersByTimeAsync(10000)

    expect(state.phase.value).toBe('win-effect')
    expect(state.result.value).toBeNull()
  })
})
