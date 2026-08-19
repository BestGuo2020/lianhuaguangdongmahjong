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
  const opening = {
    start: vi.fn(), confirm: vi.fn(), hasSnapshotForHand: vi.fn(() => false), cancel: vi.fn(),
  }
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
  const requests = { reset: vi.fn(), clearPending: vi.fn(), flush: vi.fn(), syncSnapshot: vi.fn() }
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
    state.phase.value = 'settled'
    state.result.value = { winnerIndex: 0 }
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

  it('同一轮重复或迟到的 round_start 不会再次清空并重播开局', () => {
    const { lifecycle, opening } = setup()
    const roundStart = {
      kind: 'round_start' as const, authorityEpoch: 'epoch-1', sequence: 4,
      matchStarted: true, round: 1, dealer: 0, honba: 0, dice: [2, 4] as [number, number],
    }

    lifecycle.handleRoundStart(roundStart)
    lifecycle.handleRoundStart({ ...roundStart, sequence: 5 })
    lifecycle.handleRoundStart({ ...roundStart, sequence: 3 })

    expect(opening.start).toHaveBeenCalledOnce()
  })

  it('连庄时同一 round 的新 honba 必须作为新手牌启动开局并解除 opening barrier', () => {
    const { lifecycle, opening } = setup()
    const roundStart = {
      kind: 'round_start' as const, authorityEpoch: 'epoch-1', sequence: 4,
      matchStarted: false, round: 2, dealer: 1, honba: 0, dice: [2, 4] as [number, number],
    }

    lifecycle.handleRoundStart(roundStart)
    lifecycle.handleRoundStart({ ...roundStart, sequence: 5, honba: 1, dice: [3, 5] })
    lifecycle.handleRoundStart({ ...roundStart, sequence: 6, honba: 1, dice: [3, 5] })

    expect(opening.start).toHaveBeenCalledTimes(2)
    expect(opening.start).toHaveBeenLastCalledWith(expect.objectContaining({ round: 2, honba: 1 }))
  })

  it('权威快照先到时，round_start 只去重，不重新等待已经消费过的快照', () => {
    const { state, lifecycle, opening } = setup()
    state.round.value = 2
    state.phase.value = 'playing'
    state.players.push(player(0), player(1), player(2), player(3))

    lifecycle.handleRoundStart({
      kind: 'round_start', authorityEpoch: 'epoch-1', sequence: 1,
      matchStarted: false, round: 2, dealer: 0, honba: 0, dice: [2, 4],
    })

    expect(opening.start).not.toHaveBeenCalled()
    expect(opening.confirm).toHaveBeenCalledWith(expect.objectContaining({ round: 2 }))
    expect(state.waitingNextRound.value).toBe(false)
  })

  it('权威快照先到且已缓存开局数据时，round_start 仍启动客户端动画', () => {
    const { state, lifecycle, opening } = setup()
    state.round.value = 2
    state.phase.value = 'playing'
    state.players.push(player(0), player(1), player(2), player(3))
    opening.hasSnapshotForHand.mockReturnValue(true)

    lifecycle.handleRoundStart({
      kind: 'round_start', authorityEpoch: 'epoch-1', sequence: 1,
      matchStarted: false, round: 2, dealer: 0, honba: 0, dice: [2, 4],
    })

    expect(opening.start).toHaveBeenCalledOnce()
    expect(opening.confirm).not.toHaveBeenCalled()
  })

  it('round_start 丢失时，当前房主 opening 快照仍恢复客户端动画', () => {
    const { state, lifecycle, opening } = setup()
    state.round.value = 1
    state.phase.value = 'dealing'
    state.players.push(player(0), player(1), player(2), player(3))
    opening.hasSnapshotForHand.mockReturnValue(true)

    lifecycle.handleOpeningSnapshot({
      kind: 'state_snapshot', roomId: 'ROOM01', authorityEpoch: 'epoch-1', sequence: 2,
      mode: 'east', phase: 'opening', round: 1, dealer: 2, honba: 1,
      dice: [3, 5], secondDice: [2, 4], wallCount: 83, wall: [], headDrawn: 53,
      currentPlayer: -1, players: [0, 1, 2, 3].map((seat) => player(seat) as never), seat: 1,
      result: null, announcement: null, matchFinished: false, lastDiscard: null,
      winPresentation: null, winningPlayerIndex: -1,
    })

    expect(opening.start).toHaveBeenCalledWith(expect.objectContaining({
      round: 1, dealer: 2, honba: 1, dice: [3, 5], secondDice: [2, 4],
    }))

    lifecycle.handleRoundStart({
      kind: 'round_start', authorityEpoch: 'epoch-1', sequence: 1,
      matchStarted: true, round: 1, dealer: 2, honba: 1, dice: [3, 5],
    })
    expect(opening.start).toHaveBeenCalledOnce()
  })

  it('清理继续屏障后，旧 Room 的同轮 round_start 仍会被去重', () => {
    const { lifecycle, opening } = setup()
    const roundStart = {
      kind: 'round_start' as const, authorityEpoch: 'epoch-1', sequence: 4,
      matchStarted: true, round: 1, dealer: 0, honba: 0, dice: [2, 4] as [number, number],
    }

    lifecycle.handleRoundStart(roundStart)
    lifecycle.clearRoundBarrier()
    lifecycle.handleRoundStart({ ...roundStart, sequence: 5 })

    expect(opening.start).toHaveBeenCalledOnce()
  })

  it('房主 authorityEpoch 变化后允许新生命周期从 sequence=1 开始', () => {
    const { lifecycle, opening } = setup()
    lifecycle.handleRoundStart({
      kind: 'round_start', authorityEpoch: 'old', sequence: 9,
      matchStarted: true, round: 3, dealer: 0, honba: 0, dice: [2, 4],
    })
    lifecycle.handleRoundStart({
      kind: 'round_start', authorityEpoch: 'new', sequence: 1,
      matchStarted: true, round: 1, dealer: 0, honba: 0, dice: [3, 5],
    })

    expect(opening.start).toHaveBeenCalledTimes(2)
  })

  it('丢弃滞留结算快照，只重新应用可推进的新快照', () => {
    const { state, lifecycle, snapshots, requests, setPendingSnapshot } = setup()
    // nextRound 只能由房主已经确认的本局结算状态触发。
    state.phase.value = 'settled'
    state.result.value = { winnerIndex: 0 }
    setPendingSnapshot({ phase: 'settled', result: { winnerIndex: 0 } } as unknown as ServerSnapshot)
    lifecycle.nextRound()
    expect(snapshots.apply).not.toHaveBeenCalled()

    setPendingSnapshot({ phase: 'drawing', result: null } as unknown as ServerSnapshot)
    snapshots.apply.mockReturnValue(true)
    lifecycle.nextRound()
    expect(snapshots.apply).toHaveBeenCalledWith(expect.objectContaining({ phase: 'drawing' }))
    expect(requests.syncSnapshot).toHaveBeenCalledWith(expect.objectContaining({ phase: 'drawing' }))
  })

  it('非结算阶段的继续操作不能在客户端本地制造下一局等待状态', () => {
    const { state, lifecycle, sendContinue } = setup()
    lifecycle.nextRound()

    expect(sendContinue).not.toHaveBeenCalled()
    expect(state.waitingNextRound.value).toBe(false)
  })

  it('返回房间大厅时保留房间会话，只清理牌桌并刷新房间', () => {
    const { state, lifecycle, refreshRoom } = setup()
    state.roomId.value = 'ABC123'
    state.mySeat.value = 2
    state.matchFinished.value = true
    state.phase.value = 'finished'
    state.players.push(player(2))
    lifecycle.returnToLobby()

    expect(state.phase.value).toBe('lobby')
    expect(state.players).toHaveLength(0)
    expect(state.roomId.value).toBe('ABC123')
    expect(state.mySeat.value).toBe(2)
    expect(refreshRoom).toHaveBeenCalled()
  })

})
