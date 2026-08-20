import { describe, expect, it, vi } from 'vitest'
import { createTableLoadRetryController, TABLE_LOAD_RETRY_DELAYS_MS } from './tableLoadRetry'

describe('tableLoadRetry', () => {
  it('retries with bounded backoff and exposes the final error only after exhaustion', () => {
    vi.useFakeTimers()
    const retries: Array<{ attempt: number; message: string }> = []
    const exhausted: string[] = []
    const controller = createTableLoadRetryController({
      schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
      cancel: (timer) => globalThis.clearTimeout(timer),
      onRetry: (attempt, message) => retries.push({ attempt, message }),
      onExhausted: (message) => exhausted.push(message),
    })

    for (let index = 0; index < TABLE_LOAD_RETRY_DELAYS_MS.length; index += 1) {
      controller.fail('transient network failure')
      expect(retries).toHaveLength(index)
      vi.advanceTimersByTime(TABLE_LOAD_RETRY_DELAYS_MS[index])
      expect(retries[index]).toEqual({ attempt: index + 1, message: 'transient network failure' })
    }
    controller.fail('final failure')

    expect(exhausted).toEqual(['final failure'])
    vi.useRealTimers()
  })

  it('cancels pending retries after success or disposal', () => {
    vi.useFakeTimers()
    const onRetry = vi.fn()
    const controller = createTableLoadRetryController({
      schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
      cancel: (timer) => globalThis.clearTimeout(timer),
      onRetry,
      onExhausted: vi.fn(),
    })

    controller.fail('first')
    controller.succeed()
    vi.runAllTimers()
    expect(onRetry).not.toHaveBeenCalled()

    controller.fail('second')
    controller.dispose()
    vi.runAllTimers()
    expect(onRetry).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('manual retry resets the automatic retry budget', () => {
    vi.useFakeTimers()
    const onRetry = vi.fn()
    const onExhausted = vi.fn()
    const controller = createTableLoadRetryController({
      schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
      cancel: (timer) => globalThis.clearTimeout(timer),
      onRetry,
      onExhausted,
    })

    TABLE_LOAD_RETRY_DELAYS_MS.forEach((delay) => {
      controller.fail('network')
      vi.advanceTimersByTime(delay)
    })
    controller.fail('network')
    expect(onExhausted).toHaveBeenCalledTimes(1)

    controller.manualRetry()
    controller.fail('network again')
    vi.advanceTimersByTime(TABLE_LOAD_RETRY_DELAYS_MS[0])

    expect(onRetry).toHaveBeenLastCalledWith(1, 'network again')
    vi.useRealTimers()
  })
})
