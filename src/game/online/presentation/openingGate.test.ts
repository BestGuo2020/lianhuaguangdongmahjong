import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSnapshot } from '../protocol/dto'
import { createOpeningSnapshotGate } from './openingGate'

function snapshot(round = 1, phase: ServerSnapshot['phase'] = 'opening', honba = 0): ServerSnapshot {
  return {
    kind: 'state_snapshot', roomId: 'ROOM', mode: 'east', phase, round, dealer: 0, honba,
    dice: [2, 5], wallCount: 83, wall: [], headDrawn: 53,
    players: [], seat: 0, currentPlayer: -1, result: null, announcement: null, matchFinished: false,
    lastDiscard: null, winPresentation: null, winningPlayerIndex: -1,
  }
}

describe('openingGate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('accepts only the first opening snapshot for the active round', async () => {
    const gate = createOpeningSnapshotGate()
    gate.begin(2, 1)
    const waiting = gate.wait()

    expect(gate.capture(snapshot(1))).toBe(false)
    expect(gate.capture(snapshot(2, 'opening', 0))).toBe(false)
    expect(gate.capture(snapshot(2, 'playing', 1))).toBe(false)
    expect(gate.capture(snapshot(2, 'opening', 1))).toBe(true)
    expect(gate.capture(snapshot(2, 'opening', 1))).toBe(false)
    await expect(waiting).resolves.toMatchObject({ round: 2, honba: 1, phase: 'opening' })
  })

  it('releases a pending wait when cancelled', async () => {
    const gate = createOpeningSnapshotGate()
    gate.begin(1, 0)
    const waiting = gate.wait()
    gate.cancel()
    await expect(waiting).resolves.toBeNull()
  })

  it('times out without leaving a pending promise', async () => {
    const gate = createOpeningSnapshotGate(1000)
    gate.begin(1, 0)
    const waiting = gate.wait()
    await vi.advanceTimersByTimeAsync(1000)
    await expect(waiting).resolves.toBeNull()
  })
})
