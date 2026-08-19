import { reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import type { GamePhase, OpeningStage } from '../../core/contracts/gamePort'
import type { ServerPlayerDto, ServerSnapshot } from '../protocol/dto'
import { mapPlayersToLocal } from '../protocol/mapper'
import { createOpeningTimeline, type OpeningTimelineOptions } from './openingTimeline'

function player(seat: number, count: number, hidden = false): ServerPlayerDto {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat,
    hand: hidden
      ? Array<null>(count).fill(null)
      : Array<TileType>(count).fill((['m1', 'm2', 'm3', 'm4'] as TileType[])[seat]),
    discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

function snapshot(round = 1): ServerSnapshot {
  return {
    kind: 'state_snapshot', roomId: 'A', mode: 'east', phase: 'opening', round,
    dealer: 2, honba: 0, wallCount: 83, wall: Array<TileType>(83).fill('s1'), headDrawn: 53,
    currentPlayer: 2, players: [player(0, 13, true), player(1, 13, true), player(2, 14), player(3, 13, true)],
    seat: 2, result: null, announcement: null, matchFinished: false, lastDiscard: null,
    winPresentation: null, winningPlayerIndex: -1,
    flipTile: 'm1', flipStack: 4,
  }
}

function harness(overrides: Partial<OpeningTimelineOptions> = {}) {
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
    ...overrides,
  })
  return { state, sent, finished, timeline }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('openingTimeline', () => {
  it('等待同轮权威快照时不提前改写本地轮次', async () => {
    const { state, timeline } = harness({
      waitForTableReady: () => Promise.resolve(),
      waitForOpeningSnapshot: true,
    })
    timeline.start({ kind: 'round_start', matchStarted: false, round: 2, dealer: 2, honba: 0, dice: [2, 5] })

    expect(state.round.value).toBe(1)
    timeline.captureSnapshot(snapshot(2))
    await vi.advanceTimersByTimeAsync(10000)
    expect(state.round.value).toBe(2)
  })

  it('权威快照先到时只发送当前房主代次的开局确认，不改写本地牌局', () => {
    const { state, sent, timeline } = harness({
      waitForOpeningSnapshot: true,
      getAuthorityEpoch: () => 'epoch-1',
    })
    timeline.confirm({
      kind: 'round_start', authorityEpoch: 'epoch-1', sequence: 2,
      matchStarted: false, round: 2, dealer: 2, honba: 1, dice: [2, 5],
    })

    expect(sent).toEqual([{ type: 'opening_done', round: 2, honba: 1, authorityEpoch: 'epoch-1' }])
    expect(state.round.value).toBe(1)
    expect(state.phase.value).toBe('lobby')
  })

  it('快照先到时，round_start 到达后仍播放开局并确认', async () => {
    const { state, sent, timeline } = harness({
      waitForTableReady: () => Promise.resolve(),
      waitForOpeningSnapshot: true,
    })
    timeline.primeSnapshot(snapshot(2))
    timeline.start({ kind: 'round_start', matchStarted: false, round: 2, dealer: 2, honba: 0, dice: [2, 5] })

    expect(timeline.isWaitingForSnapshot()).toBe(false)
    await vi.advanceTimersByTimeAsync(10000)

    expect(state.round.value).toBe(2)
    expect(sent).toContainEqual({ type: 'opening_done', round: 2, honba: 0 })
  })

  it('不应因 3D 牌桌尚未 ready 而跳过客户端开局阶段', () => {
    let releaseTableReady!: () => void
    const tableReady = new Promise<void>((resolve) => { releaseTableReady = resolve })
    const { state, timeline } = harness({
      waitForTableReady: () => tableReady,
      waitForOpeningSnapshot: true,
    })

    timeline.primeSnapshot(snapshot())
    timeline.start({ kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0, dice: [2, 5] })

    // 慢网/慢 WebGL 时 ready 可能还没回调，但表现层必须已经进入开局提示。
    expect(state.openingStage.value).toBe('start')

    timeline.cancel()
    releaseTableReady()
  })

  it('keeps the first captured snapshot and ignores later fast-host snapshots', async () => {
    const { state, timeline } = harness()
    timeline.start({ kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0, dice: [2, 5] })
    timeline.captureSnapshot(snapshot()) // 开局：本家(seat 2)14 张、其余 13 张

    // 无头房主推进极快，发牌动画等待期间会陆续到达 drawing/checking 快照，不能覆盖开局手牌。
    timeline.captureSnapshot({
      ...snapshot(),
      phase: 'checking',
      players: [player(0, 13, true), player(1, 13, true), player(2, 13), player(3, 13, true)],
    } as ServerSnapshot)

    await vi.advanceTimersByTimeAsync(10000)

    // 仍按第一份快照发牌：本家 14 张，其余 13 张（隐藏）。
    expect(state.players.map((item) => item.hand.length)).toEqual([14, 0, 0, 0])
    expect(state.players.map((item) => item.concealedTileCount)).toEqual([14, 13, 13, 13])
  })

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
    await vi.advanceTimersByTimeAsync(1900)
    expect(state.diceValues.value).toEqual([4, 6])
  })

  it('shows the authoritative flip stage and switches thrower before second dice', async () => {
    const { state, timeline } = harness()
    timeline.start({
      kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0,
      dice: [2, 5], secondDice: [4, 6], flipTile: 'm1', flipStack: 4, flipSeat: 1,
    })
    await vi.advanceTimersByTimeAsync(1250 + 1900)
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

    // 翻精前仍显示完整 136 张牌山（3D 用 flipStack 补回占位墩）。
    expect(state.wallCount.value).toBe(136)
    expect(state.wall.value).toHaveLength(134)
    expect(state.jokerTiles.value).toEqual(['p2', 'p3'])
    expect(state.wildcardTiles.value).toEqual(['white'])
    expect(state.flipStack.value).toBe(7)
    expect(state.openingStack.value).toBeNull()
    // 二骰结束前不能提前把牌山移动到开门断点。
    expect(state.wallBreakIndex.value).toBe(0)
    // 指示牌（flipTile）由 round_start 消息在翻精阶段才翻出；翻精墩（flipStack）开局即保留。
    expect(state.flipTile.value).toBeNull()

    await vi.advanceTimersByTimeAsync(1250 + 1900)
    expect(state.openingStage.value).toBe('flip')
    expect(state.wallCount.value).toBe(134)
    await vi.advanceTimersByTimeAsync(1200 + 1900)
    expect(state.openingStage.value).toBe('deal')
    expect(state.openingStack.value).toBe(18)
    expect(state.wallBreakIndex.value).toBe(36)
  })

  it('cancels pending animation without sending readiness', async () => {
    const { sent, timeline } = harness()
    timeline.start({ kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0, dice: [2, 5] })
    timeline.cancel()
    await vi.advanceTimersByTimeAsync(10000)

    expect(sent).toEqual([])
    expect(timeline.isRunning()).toBe(false)
  })

  it('waits for game_start audio to finish before rolling the dice', async () => {
    let releaseGameStart: (() => void) | undefined
    const gameStartDone = new Promise<void>((resolve) => { releaseGameStart = resolve })
    const { state, timeline } = harness({
      playSoundAndWait: async (name) => { if (name === 'game_start.mp3') await gameStartDone },
    })
    timeline.start({ kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0, dice: [2, 5] })

    // 音效未播完：即使超过原 1250ms 等待，仍停留在 start 阶段，骰子不展示。
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.openingStage.value).toBe('start')
    expect(state.diceValues.value).toEqual([1, 1])

    // 音效播完后才进入骰子阶段。
    releaseGameStart?.()
    await vi.advanceTimersByTimeAsync(1250)
    expect(state.openingStage.value).toBe('dice')
    expect(state.diceValues.value).toEqual([2, 5])
  })

  it('does not block opening on a rejected game_start audio', async () => {
    const { state, sent, timeline } = harness({
      playSoundAndWait: async () => { throw new Error('audio unavailable') },
    })
    timeline.start({
      kind: 'round_start', matchStarted: true, round: 1, dealer: 2, honba: 0,
      dice: [2, 5], secondDice: [4, 6], flipTile: 'm1', flipStack: 4, flipSeat: 1,
    })
    timeline.captureSnapshot(snapshot())

    await vi.advanceTimersByTimeAsync(11000)

    expect(state.openingStage.value).toBeNull()
    expect(sent).toContainEqual({ type: 'opening_done' })
  })
})
