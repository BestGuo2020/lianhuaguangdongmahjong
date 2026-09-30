import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoundSpeechGate } from './roundSpeechGate'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('roundSpeechGate', () => {
  it('waits for the matching round and accepts an early completion', async () => {
    const gate = createRoundSpeechGate()
    let finished = false
    void gate.wait('round-a').then(() => { finished = true })
    gate.complete('round-b')
    await Promise.resolve()
    expect(finished).toBe(false)
    gate.complete('round-a')
    await Promise.resolve()
    expect(finished).toBe(true)
    await expect(gate.wait('round-b')).resolves.toBeUndefined()
  })

  it('releases a canceled or stalled settlement', async () => {
    const gate = createRoundSpeechGate(100)
    const canceled = gate.wait('old-round')
    gate.reset()
    await expect(canceled).resolves.toBeUndefined()
    const stalled = gate.wait('new-round')
    await vi.advanceTimersByTimeAsync(100)
    await expect(stalled).resolves.toBeUndefined()
    await expect(gate.wait('new-round')).resolves.toBeUndefined()
  })
})
