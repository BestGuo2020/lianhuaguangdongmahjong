import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { GameMode } from '../../core/contracts/activeGamePort'
import type { GamePhase, RoundResult } from '../../core/contracts/gamePort'
import { useRemoteContinueCountdown } from './useRemoteContinueCountdown'

beforeEach(() => {
  vi.useFakeTimers()
  // 组合式函数走 window.setInterval（浏览器计时器）；node 环境需补一个 window。
  vi.stubGlobal('window', {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(enabled = ref(true)) {
  const gameMode = ref<GameMode>('remote')
  const phase = ref<GamePhase>('playing')
  const result = ref<RoundResult | null>(null)
  const matchFinished = ref(false)
  const waitingNextRound = ref(false)
  const continueRound = vi.fn()
  const countdown = useRemoteContinueCountdown({
    gameMode, phase, result, matchFinished, waitingNextRound, continueRound, enabled,
  })
  const settle = async () => {
    result.value = {
      winner: '甲', scoreChanges: [], roundLabel: '东1局', draw: false,
    } as unknown as RoundResult
    phase.value = 'settled'
    await nextTick()
  }
  return { gameMode, phase, result, matchFinished, waitingNextRound, continueRound, countdown, enabled, settle }
}

describe('useRemoteContinueCountdown', () => {
  it('结算后 10 秒自动回执下一局', async () => {
    const harness = setup()
    await harness.settle()
    expect(harness.countdown.value).toBe(10)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(harness.continueRound).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.continueRound).toHaveBeenCalledTimes(1)
  })

  it('本家回执后停止计时（等待其他玩家）', async () => {
    const harness = setup()
    await harness.settle()
    harness.waitingNextRound.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(harness.continueRound).not.toHaveBeenCalled()
  })

  it('enabled=false（血流自带结算倒计时）时完全不计时、不回执', async () => {
    const harness = setup(ref(false))
    await harness.settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.continueRound).not.toHaveBeenCalled()
  })

  it('计时中途 enabled 翻 false 立即停止（不残留隐藏回执）', async () => {
    const harness = setup()
    await harness.settle()
    await vi.advanceTimersByTimeAsync(4_000)
    harness.enabled.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.continueRound).not.toHaveBeenCalled()
  })
})
