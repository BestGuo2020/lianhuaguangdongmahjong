import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTimerScheduler } from './timerScheduler'

// 无头权威引擎靠 instant 模式把 PACE_MS/结算动画延迟归零，保证逻辑即时推进。
function stubWindow() {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
}

function scheduler(instant: boolean) {
  return createTimerScheduler({
    controllers: [],
    stopCountdown: () => {},
    cancelOpening: () => {},
    instant,
  })
}

beforeEach(stubWindow)
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('timerScheduler', () => {
  it('instant 模式 later 立即触发，忽略请求延迟', () => {
    const timer = scheduler(true)
    const callback = vi.fn()
    timer.later(callback, 600)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledOnce()
  })

  it('instant 模式 wait 立即 resolve', async () => {
    const timer = scheduler(true)
    await expect(timer.wait(600)).resolves.toBeUndefined()
  })

  it('非 instant 模式 later 尊重请求延迟', () => {
    const timer = scheduler(false)
    const callback = vi.fn()
    timer.later(callback, 600)
    vi.advanceTimersByTime(599)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledOnce()
  })
})
