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

function harness(reduced = true, llmSeat = false) {
  const state = {
    phase: ref<GamePhase>('playing'), result: ref<any>(null), winEffect: ref<any>(null),
    winPresentation: ref<any>(null), revealHands: ref(false), winningPlayerIndex: ref(-1),
  }
  const sounds: string[] = []
  const onResultMissingAfterReveal = vi.fn()
  const timeline = createSettlementTimeline({
    state,
    mapResult: (value) => value ? { ...value, winnerIndex: 0 } : null,
    mapPresentation: (value) => value ? { ...value, winnerIndex: 0 } : null,
    toLocalSeat: (seat) => (seat - 2 + 4) % 4,
    playSound: (name) => sounds.push(name),
    isLlmSeat: () => llmSeat,
    reducedMotion: () => reduced,
    onResultMissingAfterReveal,
  })
  return { state, sounds, timeline, onResultMissingAfterReveal }
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

  it('公共胡牌事件先播放，结算随后只补结果且不重播特效', async () => {
    const { state, sounds, timeline } = harness()
    const winning = snapshot()

    timeline.startEffect(winning)
    timeline.startEffect(winning)
    expect(state.phase.value).toBe('win-effect')
    expect(sounds).toEqual(['zimo.mp3'])

    timeline.start(winning)
    expect(state.phase.value).toBe('win-effect')
    expect(state.result.value).toBeNull()
    expect(sounds).toEqual(['zimo.mp3'])

    await vi.advanceTimersByTimeAsync(REDUCED_WIN_EFFECT_DURATION + REDUCED_WIN_REVEAL_DURATION)
    expect(state.phase.value).toBe('settled')
    expect(state.result.value?.winnerIndex).toBe(0)
    expect(sounds).toEqual(['zimo.mp3'])
  })

  it('胡牌表现先播完时停在亮牌阶段，收到结算后立即弹出结果', async () => {
    const { state, timeline, onResultMissingAfterReveal } = harness()
    const winning = snapshot()

    timeline.startEffect(winning)
    await vi.advanceTimersByTimeAsync(REDUCED_WIN_EFFECT_DURATION + REDUCED_WIN_REVEAL_DURATION)
    expect(state.phase.value).toBe('revealing')
    expect(state.result.value).toBeNull()
    expect(onResultMissingAfterReveal).toHaveBeenCalledWith(1, 0)

    timeline.start(winning)
    expect(state.phase.value).toBe('settled')
    expect(state.result.value?.winnerIndex).toBe(0)
  })

  it('结算事实及时到达时不触发缺失恢复事件', async () => {
    const { timeline, onResultMissingAfterReveal } = harness()
    timeline.start(snapshot())

    await vi.advanceTimersByTimeAsync(REDUCED_WIN_EFFECT_DURATION + REDUCED_WIN_REVEAL_DURATION)
    expect(onResultMissingAfterReveal).not.toHaveBeenCalled()
  })

  it('确认继续取消时间线后，同手迟到的 settled 快照不得重播胡牌表现', async () => {
    const { state, sounds, timeline } = harness()
    const winning = snapshot()

    timeline.start(winning)
    await vi.advanceTimersByTimeAsync(REDUCED_WIN_EFFECT_DURATION + REDUCED_WIN_REVEAL_DURATION)
    expect(state.phase.value).toBe('settled')
    expect(state.winEffect.value).toBeNull()
    expect(sounds).toEqual(['zimo.mp3'])

    // 模拟 nextRound()：先停止本手表现计时器，随后房主本地视图收到同手
    // 最后一份权威 settled 快照。它只能补事实，不能产生新的特效或声音。
    timeline.cancel()
    timeline.start(winning)

    expect(sounds).toEqual(['zimo.mp3'])
    expect(state.winEffect.value).toBeNull()
    expect(state.phase.value).toBe('settled')
  })

  it('完整重置后，新一场相同东1仍可播放胡牌表现', () => {
    const { state, sounds, timeline } = harness()
    const winning = snapshot()

    timeline.start(winning)
    expect(sounds).toEqual(['zimo.mp3'])

    timeline.reset()
    state.phase.value = 'playing'
    state.winEffect.value = null
    timeline.start(winning)

    expect(state.phase.value).toBe('win-effect')
    expect(state.winEffect.value).not.toBeNull()
    expect(sounds).toEqual(['zimo.mp3', 'zimo.mp3'])
  })

  it('大模型赢家由 TTS 替代自摸/胡牌人声，但仍播放胡牌特效音', async () => {
    const { sounds, timeline } = harness(false, true)
    timeline.start(snapshot())

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
