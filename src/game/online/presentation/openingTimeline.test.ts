import { reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import type { GamePhase, OpeningStage } from '../../core/contracts/gamePort'
import type { ServerSnapshot } from '../protocol/dto'
import { createOpeningTimeline } from './openingTimeline'

function player(seat: number, count: number): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat,
    hand: Array<TileType>(count).fill((['m1', 'm2', 'm3', 'm4'] as TileType[])[seat]),
    discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

function snapshot(): ServerSnapshot {
  return {
    kind: 'state_snapshot', roomId: 'A', mode: 'east', phase: 'opening', round: 1,
    dealer: 2, honba: 0, wallCount: 83, wall: Array<TileType>(83).fill('s1'), headDrawn: 53,
    currentPlayer: 2, players: [player(0, 13), player(1, 13), player(2, 14), player(3, 13)],
    seat: 2, result: null, announcement: null, matchFinished: false, lastDiscard: null,
    winPresentation: null, winningPlayerIndex: -1,
  }
}

function harness() {
  const state = {
    phase: ref<GamePhase>('lobby'), players: reactive<GamePlayer[]>([]), wall: ref<TileType[]>([]),
    wallCount: ref(0), wallHeadDrawn: ref(0), currentPlayer: ref(-1), selectedIndex: ref(-1),
    actionPrompt: ref(null), lastDiscard: ref(null), result: ref<any>(null), winEffect: ref<any>(null),
    winPresentation: ref<any>(null), revealHands: ref(false), winningPlayerIndex: ref(-1),
    round: ref(1), dealer: ref(0), honba: ref(0), diceValues: ref<number[]>([1, 1]),
    openingStage: ref<OpeningStage | null>(null), dealAnimation: ref({ playerIndex: -1, count: 0, serial: 0 }),
  }
  const sent: Array<Record<string, unknown>> = []
  const finished = vi.fn()
  const timeline = createOpeningTimeline({
    state,
    toLocalSeat: (seat) => (seat - 2 + 4) % 4,
    mapPlayers: (players) => [...players].sort((a, b) => ((a.seat - 2 + 4) % 4) - ((b.seat - 2 + 4) % 4)),
    playSound: () => {},
    playSoundAndWait: async () => {},
    send: (message) => sent.push(message),
    onFinished: finished,
  })
  return { state, sent, finished, timeline }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('openingTimeline', () => {
  it('runs start, dice and authoritative deal animation before opening_done', async () => {
    const { state, sent, finished, timeline } = harness()
    timeline.start({ kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0, dice: [2, 5] })
    expect(state.openingStage.value).toBe('start')
    timeline.captureSnapshot(snapshot())
    expect(state.wallCount.value).toBe(136)

    await vi.advanceTimersByTimeAsync(10000)

    expect(state.openingStage.value).toBeNull()
    expect(state.players.map((item) => item.hand.length)).toEqual([14, 13, 13, 13])
    expect(state.wallCount.value).toBe(83)
    expect(state.wallHeadDrawn.value).toBe(53)
    expect(finished).toHaveBeenCalledOnce()
    expect(sent).toContainEqual({ type: 'opening_done' })
  })

  it('cancels pending animation without sending readiness', async () => {
    const { sent, timeline } = harness()
    timeline.start({ kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0, dice: [2, 5] })
    timeline.cancel()
    await vi.advanceTimersByTimeAsync(10000)

    expect(sent).toEqual([])
    expect(timeline.isRunning()).toBe(false)
  })
})
