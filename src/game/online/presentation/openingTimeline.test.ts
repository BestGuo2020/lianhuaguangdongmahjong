import { reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import type { GamePhase, OpeningStage } from '../../core/contracts/gamePort'
import type { ServerPlayerDto, ServerSnapshot } from '../protocol/dto'
import { mapPlayersToLocal } from '../protocol/mapper'
import { createOpeningTimeline } from './openingTimeline'

function player(seat: number, count: number, hidden = false): ServerPlayerDto {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat,
    hand: hidden
      ? Array<null>(count).fill(null)
      : Array<TileType>(count).fill((['m1', 'm2', 'm3', 'm4'] as TileType[])[seat]),
    discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

function snapshot(): ServerSnapshot {
  return {
    kind: 'state_snapshot', roomId: 'A', mode: 'east', phase: 'opening', round: 1,
    dealer: 2, honba: 0, wallCount: 83, wall: Array<TileType>(83).fill('s1'), headDrawn: 53,
    currentPlayer: 2, players: [player(0, 13, true), player(1, 13, true), player(2, 14), player(3, 13, true)],
    seat: 2, result: null, announcement: null, matchFinished: false, lastDiscard: null,
    winPresentation: null, winningPlayerIndex: -1,
    flipTile: 'm1', flipStack: 4,
  }
}

function harness() {
  const state = {
    phase: ref<GamePhase>('lobby'), players: reactive<GamePlayer[]>([]), wall: ref<TileType[]>([]),
    wallCount: ref(0), wallHeadDrawn: ref(0), currentPlayer: ref(-1), selectedIndex: ref(-1),
    actionPrompt: ref(null), lastDiscard: ref(null), result: ref<any>(null), winEffect: ref<any>(null),
    winPresentation: ref<any>(null), revealHands: ref(false), winningPlayerIndex: ref(-1),
    round: ref(1), dealer: ref(0), honba: ref(0), diceValues: ref<number[]>([1, 1]), secondDice: ref<[number, number]>([1, 1]), flipTile: ref<TileType | null>(null), jokerTiles: ref<TileType[]>([]), wildcardTiles: ref<TileType[]>([]), flipStack: ref<number | null>(null), openingStack: ref<number | null>(null), wallBreakIndex: ref(0), diceThrowerIndex: ref(0),
    openingStage: ref<OpeningStage | null>(null), dealAnimation: ref({ playerIndex: -1, count: 0, serial: 0 }), announcement: ref(null),
  }
  const sent: Array<Record<string, unknown>> = []
  const finished = vi.fn()
  const timeline = createOpeningTimeline({
    state,
    toLocalSeat: (seat) => (seat - 2 + 4) % 4,
    mapPlayers: (players) => mapPlayersToLocal(players, 2),
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
    expect(state.players.map((item) => item.hand.length)).toEqual([14, 0, 0, 0])
    expect(state.players.map((item) => item.concealedTileCount)).toEqual([14, 13, 13, 13])
    expect(state.wallCount.value).toBe(83)
    expect(state.wallHeadDrawn.value).toBe(53)
    expect(state.wallBreakIndex.value).toBe(0)
    expect(finished).toHaveBeenCalledOnce()
    expect(sent).toContainEqual({ type: 'opening_done' })
  })

  it('shows the first dice at the dice stage and second dice before dealing', async () => {
    const { state, timeline } = harness()
    timeline.start({ kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0, dice: [2, 5], secondDice: [4, 6] })
    // 骰子在 start 阶段复位，不提前展示。
    expect(state.diceValues.value).toEqual([1, 1])
    await vi.advanceTimersByTimeAsync(1250)
    expect(state.diceValues.value).toEqual([2, 5])
    await vi.advanceTimersByTimeAsync(1600)
    expect(state.diceValues.value).toEqual([4, 6])
  })

  it('shows the authoritative flip stage and switches thrower before second dice', async () => {
    const { state, timeline } = harness()
    timeline.start({
      kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0,
      dice: [2, 5], secondDice: [4, 6], flipTile: 'm1', flipStack: 4, flipSeat: 1,
    })
    await vi.advanceTimersByTimeAsync(1250 + 1600)
    expect(state.openingStage.value).toBe('flip')
    expect(state.flipTile.value).toBe('m1')
    expect(state.flipStack.value).toBe(4)
    expect(state.announcement.value?.text).toContain('翻精')
    await vi.advanceTimersByTimeAsync(1200)
    expect(state.diceThrowerIndex.value).toBe(3)
    expect(state.diceValues.value).toEqual([4, 6])
  })

  it('uses the Lotus wall size and authoritative snapshot metadata during opening', async () => {
    const { state, timeline } = harness()
    timeline.start({
      kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0,
      dice: [2, 5], secondDice: [4, 6], flipTile: 'm1', flipStack: 4, flipSeat: 1,
    })
    timeline.captureSnapshot({
      ...snapshot(), rulesetId: 'lotus-legacy', wallCount: 83,
      wall: Array<TileType>(83).fill('s1'), secondDice: [4, 6], flipTile: 'p2',
      jokerTiles: ['p2', 'p3'], wildcardTiles: ['white'], flipStack: 7,
      openingStack: 18, wallBreakIndex: 36,
    })

    expect(state.wallCount.value).toBe(134)
    expect(state.wall.value).toHaveLength(134)
    expect(state.jokerTiles.value).toEqual(['p2', 'p3'])
    expect(state.wildcardTiles.value).toEqual(['white'])
    expect(state.flipStack.value).toBe(7)
    expect(state.openingStack.value).toBe(18)
    expect(state.wallBreakIndex.value).toBe(36)
    // 指示牌（flipTile）由 round_start 消息在翻精阶段才翻出；翻精墩（flipStack）开局即保留。
    expect(state.flipTile.value).toBeNull()
  })

  it('cancels pending animation without sending readiness', async () => {
    const { sent, timeline } = harness()
    timeline.start({ kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0, dice: [2, 5] })
    timeline.cancel()
    await vi.advanceTimersByTimeAsync(10000)

    expect(sent).toEqual([])
    expect(timeline.isRunning()).toBe(false)
  })

  it('does not block opening readiness on a stalled audio promise', async () => {
    const { sent, timeline } = harness()
    timeline.start({
      kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0,
      dice: [2, 5], secondDice: [4, 6], flipTile: 'm1', flipStack: 4, flipSeat: 1,
    })
    timeline.captureSnapshot(snapshot())

    await vi.advanceTimersByTimeAsync(11000)

    expect(sent).toContainEqual({ type: 'opening_done' })
  })
})
