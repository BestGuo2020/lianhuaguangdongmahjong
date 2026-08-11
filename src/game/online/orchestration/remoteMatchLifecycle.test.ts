import { describe, expect, it, vi } from 'vitest'
import type { GamePlayer } from '../../core/contracts/types'
import type { ServerSnapshot } from '../protocol/dto'
import { createRemoteGameState } from '../state/remoteGameState'
import { createRemoteMatchLifecycle } from './remoteMatchLifecycle'

function player(seat: number, score = 1000): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score, seat, hand: [], discards: [], melds: [],
    redCount: 0, drawnTileIndex: -1,
  }
}

function setup() {
  const state = createRemoteGameState({ guestId: 'guest-1', autoPlay: true })
  let showingResult = false
  let pendingSnapshot: ServerSnapshot | null = null
  const opening = { start: vi.fn(), cancel: vi.fn() }
  const settlement = { cancel: vi.fn() }
  const snapshots = {
    reset: vi.fn(),
    clearPending: vi.fn(() => { pendingSnapshot = null }),
    takePending: vi.fn(() => {
      const snapshot = pendingSnapshot
      pendingSnapshot = null
      return snapshot
    }),
    apply: vi.fn(),
  }
  const requests = { reset: vi.fn(), clearPending: vi.fn(), flush: vi.fn() }
  const transientEvents = { clear: vi.fn() }
  const sendContinue = vi.fn()
  const refreshRoom = vi.fn()
  const lifecycle = createRemoteMatchLifecycle({
    state,
    isShowingRoundResult: () => showingResult,
    clearTimers: vi.fn(),
    opening,
    settlement,
    snapshots,
    requests,
    transientEvents,
    sendContinue,
    refreshRoom,
  })
  return {
    state, lifecycle, opening, settlement, snapshots, requests, transientEvents,
    sendContinue, refreshRoom,
    setShowingResult: (value: boolean) => { showingResult = value },
    setPendingSnapshot: (value: ServerSnapshot | null) => { pendingSnapshot = value },
  }
}

describe('remoteMatchLifecycle', () => {
  it('完整重置对局和房间状态，但保留匿名身份与自动操作偏好', () => {
    const { state, lifecycle, snapshots, requests, transientEvents } = setup()
    state.roomId.value = 'ABC123'
    state.players.push(player(0))
    state.phase.value = 'playing'
    state.userDrewThisTurn.value = true
    lifecycle.resetAll()

    expect(state.phase.value).toBe('lobby')
    expect(state.roomId.value).toBe('')
    expect(state.players).toHaveLength(0)
    expect(state.userDrewThisTurn.value).toBe(false)
    expect(state.playerId.value).toBe('guest-1')
    expect(state.autoPlay.value).toBe(true)
    expect(snapshots.reset).toHaveBeenCalled()
    expect(requests.reset).toHaveBeenCalled()
    expect(transientEvents.clear).toHaveBeenCalled()
  })

  it('在结算屏障缓冲 round_start，确认继续后启动开局并刷新缓冲请求', () => {
    const { state, lifecycle, opening, requests, sendContinue, setShowingResult } = setup()
    const roundStart = {
      kind: 'round_start' as const, matchStarted: false, round: 2,
      dealer: 1, honba: 0, dice: [2, 4] as [number, number],
    }
    setShowingResult(true)
    lifecycle.handleRoundStart(roundStart)
    expect(opening.start).not.toHaveBeenCalled()

    lifecycle.nextRound()
    expect(sendContinue).toHaveBeenCalledOnce()
    expect(opening.start).toHaveBeenCalledWith(roundStart)
    expect(state.waitingNextRound.value).toBe(false)
    expect(requests.flush).toHaveBeenCalled()
  })

  it('丢弃滞留结算快照，只重新应用可推进的新快照', () => {
    const { lifecycle, snapshots, setPendingSnapshot } = setup()
    setPendingSnapshot({ phase: 'settled', result: { winnerIndex: 0 } } as unknown as ServerSnapshot)
    lifecycle.nextRound()
    expect(snapshots.apply).not.toHaveBeenCalled()

    setPendingSnapshot({ phase: 'drawing', result: null } as unknown as ServerSnapshot)
    lifecycle.nextRound()
    expect(snapshots.apply).toHaveBeenCalledWith(expect.objectContaining({ phase: 'drawing' }))
  })

  it('返回房间大厅时保留房间会话，只清理牌桌并刷新房间', () => {
    const { state, lifecycle, refreshRoom } = setup()
    state.roomId.value = 'ABC123'
    state.rejoinCode.value = 'CODE'
    state.mySeat.value = 2
    state.matchFinished.value = true
    state.phase.value = 'finished'
    state.players.push(player(2))
    lifecycle.returnToLobby()

    expect(state.phase.value).toBe('lobby')
    expect(state.players).toHaveLength(0)
    expect(state.roomId.value).toBe('ABC123')
    expect(state.rejoinCode.value).toBe('CODE')
    expect(state.mySeat.value).toBe(2)
    expect(refreshRoom).toHaveBeenCalled()
  })

  it('场次结束时更新服务端最终分数并清理推进屏障', () => {
    const { state, lifecycle, snapshots, requests } = setup()
    state.players.push(player(0), player(1))
    lifecycle.finishMatch([
      { seat: 0, name: 'P0', score: 1800 },
      { seat: 1, name: 'P1', score: 200 },
    ])

    expect(state.phase.value).toBe('finished')
    expect(state.players.map((item) => item.score)).toEqual([1800, 200])
    expect(snapshots.clearPending).toHaveBeenCalled()
    expect(requests.clearPending).toHaveBeenCalled()
  })
})
