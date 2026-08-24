import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REDUCED_WIN_EFFECT_DURATION, REDUCED_WIN_REVEAL_DURATION, WIN_EFFECT_SOUND_DELAY } from '../../core/presentation/winEffect'
import type { ServerSnapshot } from '../protocol/dto'
import type { GamePhase } from '../../core/contracts/gamePort'
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

function harness(reduced = true) {
  const state = {
    phase: ref<GamePhase>('playing'), result: ref<any>(null), winEffect: ref<any>(null),
    winPresentation: ref<any>(null), revealHands: ref(false), winningPlayerIndex: ref(-1),
  }
  const sounds: string[] = []
  const timeline = createSettlementTimeline({
    state,
    mapResult: (value) => value ? { ...value, winnerIndex: 0 } : null,
    mapPresentation: (value) => value ? { ...value, winnerIndex: 0 } : null,
    toLocalSeat: (seat) => (seat - 2 + 4) % 4,
    playSound: (name) => sounds.push(name),
    reducedMotion: () => reduced,
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

  it('settles a draw immediately without a reveal pause', async () => {
    const { state, timeline } = harness()
    timeline.start(snapshot({ result: { draw: true }, winPresentation: null, winningPlayerIndex: -1 }))

    expect(state.phase.value).toBe('settled')
    expect(state.revealHands.value).toBe(true)
    expect(state.result.value?.draw).toBe(true)
  })

  it('大模型赢家由 TTS 替代自摸/胡牌人声，但仍播放胡牌特效音', async () => {
    const { sounds, timeline } = harness(false)
    timeline.start(snapshot({
      players: [{
        name: 'LLM', avatar: '', isLlm: true, score: 1000, seat: 2,
        hand: [], discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
      }],
    }))

    expect(sounds).toEqual([])
    await vi.advanceTimersByTimeAsync(WIN_EFFECT_SOUND_DELAY)
    expect(sounds).toEqual(['hu_effect_sound.mp3'])
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
