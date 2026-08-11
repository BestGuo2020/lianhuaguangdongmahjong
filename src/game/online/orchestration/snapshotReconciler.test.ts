import { describe, expect, it, vi } from 'vitest'
import type { GamePlayer } from '../../core/contracts/types'
import type { ServerSnapshot } from '../protocol/dto'
import { createRemoteGameState } from '../state/remoteGameState'
import { createSnapshotReconciler } from './snapshotReconciler'

function player(seat: number): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand: [], discards: [],
    melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

function snapshot(overrides: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    kind: 'state_snapshot', roomId: 'ABC123', mode: 'east', phase: 'drawing',
    round: 1, dealer: 0, honba: 0, wallCount: 80, wall: [], headDrawn: 52,
    currentPlayer: 2, players: [0, 1, 2, 3].map(player), seat: 2,
    result: null, announcement: null, matchFinished: false, lastDiscard: null,
    winPresentation: null, winningPlayerIndex: -1,
    ...overrides,
  }
}

function setup() {
  const state = createRemoteGameState({ autoPlay: false })
  let opening = false
  let showingResult = false
  const captureSnapshot = vi.fn()
  const settlement = { start: vi.fn(), cancel: vi.fn() }
  const playSound = vi.fn()
  const onFinishedSnapshot = vi.fn()
  const scheduled: Array<() => void> = []
  const reconciler = createSnapshotReconciler({
    state,
    getLocalSeat: () => 2,
    isShowingRoundResult: () => showingResult,
    opening: { isRunning: () => opening, captureSnapshot },
    settlement,
    clearCountdown: vi.fn(),
    onFinishedSnapshot,
    playSound,
    later: (callback) => { scheduled.push(callback) },
  })
  return {
    state, reconciler, captureSnapshot, settlement, playSound, onFinishedSnapshot,
    setOpening: (value: boolean) => { opening = value },
    setShowingResult: (value: boolean) => { showingResult = value },
  }
}

describe('snapshotReconciler', () => {
  it('keeps an empty-player room snapshot in the lobby instead of showing a blank table', () => {
    const { state, reconciler } = setup()

    reconciler.apply(snapshot({ phase: 'drawing', players: [] }))

    expect(state.phase.value).toBe('lobby')
    expect(state.players).toHaveLength(0)
  })

  it('开局期间缓冲快照，结束后按本家座位统一映射并落地', () => {
    const { state, reconciler, captureSnapshot, playSound, setOpening } = setup()
    const incoming = snapshot({
      lastDiscard: { tile: 'm5', from: 0, id: 7 },
      announcement: { text: '东1局 · 开牌', tone: 'gold', id: 3 },
    })

    setOpening(true)
    reconciler.apply(incoming)
    expect(captureSnapshot).toHaveBeenCalledWith(incoming)
    expect(state.players).toHaveLength(0)

    setOpening(false)
    reconciler.flush()
    expect(state.players.map((item) => item.seat)).toEqual([2, 3, 0, 1])
    expect(state.currentPlayer.value).toBe(0)
    expect(state.dealer.value).toBe(2)
    expect(state.lastDiscard.value?.from).toBe(2)
    expect(state.announcement.value?.id).toBe(3)
    expect(playSound).toHaveBeenCalledWith('dapai.mp3', 0.8)

    reconciler.applyNow(incoming)
    expect(playSound.mock.calls.filter(([name]) => name === 'dapai.mp3')).toHaveLength(1)
  })

  it('结算展示期间只保留最新快照', () => {
    const { state, reconciler, setShowingResult } = setup()
    setShowingResult(true)
    reconciler.apply(snapshot({ round: 2 }))
    reconciler.apply(snapshot({ round: 3 }))
    expect(state.round.value).toBe(1)

    setShowingResult(false)
    reconciler.flush()
    expect(state.round.value).toBe(3)
  })

  it('分别把结算与场次结束快照交给对应时间线和收尾回调', () => {
    const { state, reconciler, settlement, onFinishedSnapshot } = setup()
    const settled = snapshot({
      phase: 'settled',
      result: {
        winnerIndex: 2, winner: 'P2', roundLabel: '东1局', honba: 0,
        horses: [], hits: 0, multiplier: 1, totalMultiplier: 1,
        points: 100, totalWon: 300, details: [], scoreChanges: [],
      },
    })
    reconciler.apply(settled)
    expect(settlement.start).toHaveBeenCalledWith(settled)

    reconciler.applyNow(snapshot({ phase: 'finished', matchFinished: true }))
    expect(settlement.cancel).toHaveBeenCalled()
    expect(onFinishedSnapshot).toHaveBeenCalled()
    expect(state.phase.value).toBe('finished')
    expect(state.revealHands.value).toBe(true)
  })
})
