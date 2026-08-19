import { describe, expect, it, vi } from 'vitest'
import type { GamePlayer } from '../../core/contracts/types'
import type { ServerSnapshot } from '../protocol/dto'
import type { RoundSettledMessage } from '../protocol/messages'
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

function settledNotice(overrides: Partial<RoundSettledMessage> = {}): RoundSettledMessage {
  return {
    kind: 'round_settled', roomId: 'ABC123', authorityEpoch: 'epoch-1', sequence: 11,
    mode: 'east', rulesetId: 'lotus-legacy', round: 2, honba: 1, dealer: 1,
    result: { winnerIndex: 3, winner: 'P3', roundLabel: '东2局', honba: 1 },
    winPresentation: null, winningPlayerIndex: 3,
    scores: [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, score: 1000 + seat * 100 })),
    ...overrides,
  }
}

function setup() {
  const state = createRemoteGameState({ autoPlay: false })
  let opening = false
  let waitingForOpeningSnapshot = false
  let showingResult = false
  const captureSnapshot = vi.fn()
  const settlement = { start: vi.fn(), cancel: vi.fn() }
  const openingCancel = vi.fn()
  const playSound = vi.fn()
  const onFinishedSnapshot = vi.fn()
  const scheduled: Array<() => void> = []
  const reconciler = createSnapshotReconciler({
    state,
    getLocalSeat: () => 2,
    isShowingRoundResult: () => showingResult,
    opening: {
      isRunning: () => opening,
      isWaitingForSnapshot: () => waitingForOpeningSnapshot,
      captureSnapshot,
      cancel: openingCancel,
    },
    settlement,
    clearCountdown: vi.fn(),
    onFinishedSnapshot,
    playSound,
    later: (callback) => { scheduled.push(callback) },
  })
  return {
    state, reconciler, captureSnapshot, openingCancel, settlement, playSound, onFinishedSnapshot,
    setOpening: (value: boolean) => { opening = value },
    setWaitingForOpeningSnapshot: (value: boolean) => { waitingForOpeningSnapshot = value },
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

  it('远端快照省略 wall 时按 wallCount 保留牌山占位，重连后牌山不消失', () => {
    const { state, reconciler } = setup()

    reconciler.applyNow(snapshot({ wall: undefined, wallCount: 81, headDrawn: 53 }))

    expect(state.wall.value).toHaveLength(81)
    expect(state.wall.value.every((tile) => tile === 'm1')).toBe(true)
    expect(state.wallCount.value).toBe(81)
    expect(state.wallHeadDrawn.value).toBe(53)
  })

  it('新手 opening 重建牌墙不误报回跳，但同手 playing 回跳仍告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { reconciler } = setup()

    // round 已推进、牌墙还未重置的过渡快照，随后才到真正的 opening 基线。
    reconciler.applyNow(snapshot({ round: 3, honba: 0, phase: 'drawing', wallCount: 56, headDrawn: 77 }))
    reconciler.applyNow(snapshot({ round: 3, honba: 0, phase: 'opening', wallCount: 81, headDrawn: 53 }))
    expect(warn.mock.calls.filter(([message]) => message === '[wall-regress] 牌山回跳/重建')).toHaveLength(0)

    // 同一手进入 playing 后，牌墙增长/head 回退才是真正的异常。
    reconciler.applyNow(snapshot({ round: 3, honba: 0, phase: 'drawing', wallCount: 50, headDrawn: 84 }))
    reconciler.applyNow(snapshot({ round: 3, honba: 0, phase: 'drawing', wallCount: 70, headDrawn: 60 }))
    expect(warn.mock.calls.filter(([message]) => message === '[wall-regress] 牌山回跳/重建')).toHaveLength(1)
    warn.mockRestore()
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

  it('定向 settled 快照缺失时用公共结算事实进入结算，并幂等忽略每秒重发', () => {
    const {
      state, reconciler, settlement, openingCancel, onFinishedSnapshot, setShowingResult,
    } = setup()
    reconciler.applyNow(snapshot({ authorityEpoch: 'epoch-1', sequence: 10 }))

    const first = settledNotice()
    expect(reconciler.applySettlementNotice(first)).toBe(true)
    expect(openingCancel).toHaveBeenCalled()
    expect(onFinishedSnapshot).toHaveBeenCalled()
    expect(settlement.start).toHaveBeenCalledTimes(1)
    expect(settlement.start).toHaveBeenCalledWith(first)
    expect(state.round.value).toBe(2)
    expect(state.honba.value).toBe(1)
    expect(state.dealer.value).toBe(3)
    expect(state.players.map((item) => item.score)).toEqual([1200, 1300, 1000, 1100])

    setShowingResult(true)
    state.phase.value = 'settled'
    state.result.value = first.result
    expect(reconciler.applySettlementNotice(settledNotice({
      sequence: 12,
      scores: [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, score: 2000 + seat * 100 })),
    }))).toBe(true)
    expect(settlement.start).toHaveBeenCalledTimes(1)
    expect(state.players.map((item) => item.score)).toEqual([2200, 2300, 2000, 2100])
    expect(reconciler.applySettlementNotice(settledNotice({ sequence: 11 }))).toBe(false)
  })

  it('同序结算事实被门禁拒绝时不会伪造已结算状态', () => {
    const { state, reconciler, settlement } = setup()
    reconciler.applyNow(snapshot({ authorityEpoch: 'epoch-1', sequence: 11, phase: 'playing' }))

    expect(reconciler.applySettlementNotice(settledNotice({ sequence: 11 }))).toBe(false)
    expect(settlement.start).not.toHaveBeenCalled()
    expect(state.phase.value).toBe('playing')
    expect(state.result.value).toBeNull()
  })

  it('公共胡牌特效播放中仍把随后结算事实交给同一时间线补齐结果', () => {
    const { state, reconciler, settlement, setShowingResult } = setup()
    reconciler.applyNow(snapshot({ authorityEpoch: 'epoch-1', sequence: 10 }))
    setShowingResult(true)
    state.phase.value = 'win-effect'
    state.result.value = null

    const notice = settledNotice()
    expect(reconciler.applySettlementNotice(notice)).toBe(true)
    expect(settlement.start).toHaveBeenCalledWith(notice)
  })

  it('公共胡牌特效播放中收到定向 settled 快照时立即补结果而不缓存', () => {
    const { state, reconciler, settlement, setShowingResult } = setup()
    reconciler.applyNow(snapshot({ authorityEpoch: 'epoch-1', sequence: 10 }))
    setShowingResult(true)
    state.phase.value = 'win-effect'

    const settled = snapshot({
      authorityEpoch: 'epoch-1', sequence: 11, phase: 'settled',
      result: {
        winnerIndex: 2, winner: 'P2', roundLabel: '东1局', honba: 0,
        horses: [], hits: 0, multiplier: 1, totalMultiplier: 1,
        points: 100, totalWon: 300, details: [], scoreChanges: [],
      },
      winningPlayerIndex: 2,
      winPresentation: {
        winnerIndex: 2, tile: 'm1', sourceIndex: -1, robbedKong: false,
        robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1,
      },
    })
    expect(reconciler.apply(settled)).toBe(true)
    expect(settlement.start).toHaveBeenCalledWith(settled)
    expect(reconciler.takePending()).toBeNull()
  })

  it('匹配结束（快照路径）清除「已确认，等待其他玩家」标记', () => {
    // 回归：房主只广播快照、不发 match_finished 消息；东四局/南四局打完若不清
    // waitingNextRound，所有端都会永远显示「等待其他玩家确认」。
    const { state, reconciler } = setup()
    state.waitingNextRound.value = true
    reconciler.applyNow(snapshot({ phase: 'finished', matchFinished: true }))
    expect(state.waitingNextRound.value).toBe(false)
    expect(state.matchFinished.value).toBe(true)
  })

  it('结算展示期间到达的匹配结束快照不被缓冲，立即落地（最终排名页正常出现）', () => {
    // 回归：最后一局打完、玩家点继续后，客户端仍处于「结算展示中」（phase='settled'+result），
    // 匹配结束快照若被缓冲，将没有 round_start 触发 flush，最终排名页永远不出现。
    const { state, reconciler, setShowingResult } = setup()
    setShowingResult(true)
    state.phase.value = 'settled'
    state.result.value = {
      winnerIndex: 2, winner: 'P2', roundLabel: '东4局', honba: 0,
      horses: [], hits: 0, multiplier: 1, totalMultiplier: 1,
      points: 100, totalWon: 300, details: [], scoreChanges: [],
    }
    state.waitingNextRound.value = true

    reconciler.apply(snapshot({ phase: 'finished', matchFinished: true }))

    expect(state.matchFinished.value).toBe(true)
    expect(state.phase.value).toBe('finished')
    expect(state.waitingNextRound.value).toBe(false)
  })

  it('房主返回大厅（lobby 快照）不清掉客户端正在展示的最终排名', () => {
    // 回归：客户端 matchFinished=true 展示最终排名时，房主「返回大厅」广播的
    // lobby 快照（空玩家）不得落地——否则 players 被清空、standings 消失。
    const { state, reconciler } = setup()
    state.matchFinished.value = true
    state.phase.value = 'finished'
    state.round.value = 4
    state.players.splice(0, state.players.length, player(0))

    reconciler.applyNow(snapshot({ phase: 'lobby', players: [], matchFinished: false, round: 1 }))

    // 最终排名数据保留：players 未被清空、matchFinished/phase 保持展示态。
    expect(state.players).toHaveLength(1)
    expect(state.matchFinished.value).toBe(true)
    expect(state.phase.value).toBe('finished')
  })

  it('当前房间的完整非终局快照可清理旧连接残留的最终结算状态', () => {
    const { state, reconciler } = setup()
    state.matchFinished.value = true
    state.phase.value = 'finished'
    state.revealHands.value = true

    reconciler.applyNow(snapshot({ phase: 'drawing', round: 2, matchFinished: false }))

    expect(state.matchFinished.value).toBe(false)
    expect(state.phase.value).toBe('playing')
    expect(state.revealHands.value).toBe(false)
    expect(state.round.value).toBe(2)
  })

  it('房主代次变化时重置事件去重游标，允许新生命周期的首个弃牌提示', () => {
    const { state, reconciler, playSound } = setup()
    const first = snapshot({
      authorityEpoch: 'old', sequence: 1,
      lastDiscard: { tile: 'm5', from: 0, id: 1 },
    })
    reconciler.applyNow(first)
    playSound.mockClear()

    reconciler.setAuthorityEpoch('new')
    const next = snapshot({
      authorityEpoch: 'new', sequence: 1,
      lastDiscard: { tile: 'm5', from: 0, id: 1 },
    })
    reconciler.applyNow(next)

    expect(state.lastDiscard.value?.id).toBe(1)
    expect(playSound).toHaveBeenCalledWith('dapai.mp3', 0.8)
  })

  it('新的非结算房主快照会取消上一局的结算动画，旧定时器不能复活结算页', () => {
    const { reconciler, settlement } = setup()
    const settled = snapshot({
      phase: 'settled',
      result: {
        winnerIndex: 2, winner: 'P2', roundLabel: '东1局', honba: 0,
        horses: [], hits: 0, multiplier: 1, totalMultiplier: 1,
        points: 100, totalWon: 300, details: [], scoreChanges: [],
      },
    })
    reconciler.applyNow(settled)
    settlement.cancel.mockClear()

    reconciler.applyNow(snapshot({ phase: 'drawing', round: 2 }))

    expect(settlement.cancel).toHaveBeenCalledTimes(1)
  })

  it('开局动画未完成但房主已进入更后轮次时，最新快照取消旧动画并直接收敛', () => {
    const { state, reconciler, openingCancel, setOpening } = setup()
    setOpening(true)
    expect(reconciler.apply(snapshot({ round: 2, phase: 'drawing' }))).toBe(true)

    expect(openingCancel).toHaveBeenCalledOnce()
    expect(state.round.value).toBe(2)
  })

  it('round_start 先到时，先用同轮权威快照配对，不能把它误判成未来轮次', () => {
    const { state, reconciler, captureSnapshot, openingCancel, setOpening, setWaitingForOpeningSnapshot } = setup()
    setOpening(true)
    setWaitingForOpeningSnapshot(true)

    const incoming = snapshot({ round: 2, phase: 'opening', sequence: 2, authorityEpoch: 'epoch-1' })
    expect(reconciler.apply(incoming)).toBe(false)
    expect(captureSnapshot).toHaveBeenCalledWith(incoming)
    expect(openingCancel).not.toHaveBeenCalled()
    expect(state.round.value).toBe(1)
  })

  it('开局快照先到时先暂存，不能跳过随后到达的客户端开局动画', () => {
    const { state, reconciler, setOpening } = setup()
    const openingSnapshot = snapshot({
      phase: 'opening', round: 2, sequence: 2, authorityEpoch: 'epoch-1',
    })

    expect(reconciler.apply(openingSnapshot)).toBe(false)
    expect(state.round.value).toBe(2)
    expect(state.phase.value).toBe('dealing')
    expect(state.players).toHaveLength(4)

    // 模拟 round_start 已启动动画；动画完成后的 flush 才允许快照落地。
    setOpening(true)
    expect(reconciler.flush()).toEqual(openingSnapshot)
    expect(state.round.value).toBe(2)
    expect(state.phase.value).toBe('playing')
    expect(state.players).toHaveLength(4)
  })

  it('dealing 快照在开局前到达时只缓存不落地（避免跳过开局动画）', () => {
    // 房主引擎 headless 开局时，摸牌进度 watcher 会在 round_start 之前广播
    // 带完整手牌的 dealing 快照；若立即落地，handleRoundStart 会误判「本局已
    // 渲染」并跳过 start/dice/deal 动画（四端都看不到开局提示层）。
    const { state, reconciler, setOpening } = setup()
    const dealingSnapshot = snapshot({
      phase: 'dealing', round: 1, sequence: 1, authorityEpoch: 'epoch-1',
    })

    // 开局时间线未运行：dealing 快照只缓存，不预渲染完整手牌/回合状态。
    expect(reconciler.apply(dealingSnapshot)).toBe(false)
    expect(state.players).toHaveLength(0)
    expect(state.phase.value).toBe('lobby')

    // 开局动画结束后 flush 才落地缓存的最新快照。
    setOpening(true)
    expect(reconciler.flush()).toEqual(dealingSnapshot)
    expect(state.players).toHaveLength(4)
    expect(state.phase.value).toBe('playing')
  })

  it('同一房主代次拒绝倒序快照，旧终局不能覆盖当前状态', () => {
    const { state, reconciler } = setup()
    const finished = snapshot({ authorityEpoch: 'epoch-1', sequence: 20, phase: 'finished', matchFinished: true })
    const stalePlaying = snapshot({ authorityEpoch: 'epoch-1', sequence: 19, phase: 'drawing', matchFinished: false })

    expect(reconciler.applyNow(finished)).toBe(true)
    expect(reconciler.applyNow(stalePlaying)).toBe(false)
    expect(state.matchFinished.value).toBe(true)
    expect(state.phase.value).toBe('finished')
  })

  it('拒绝零序号快照，生产房主序列从 1 开始', () => {
    const { state, reconciler } = setup()
    expect(reconciler.applyNow(snapshot({ authorityEpoch: 'epoch-1', sequence: 0 }))).toBe(false)
    expect(state.players).toHaveLength(0)
  })

  it('不完整的终局标志不会切入最终排名页', () => {
    const { state, reconciler, onFinishedSnapshot } = setup()

    expect(reconciler.applyNow(snapshot({ phase: 'finished', matchFinished: false }))).toBe(true)
    expect(state.matchFinished.value).toBe(false)
    expect(state.phase.value).toBe('playing')
    expect(onFinishedSnapshot).not.toHaveBeenCalled()

    expect(reconciler.applyNow(snapshot({ phase: 'drawing', matchFinished: true }))).toBe(true)
    expect(state.matchFinished.value).toBe(false)
    expect(state.phase.value).toBe('playing')
    expect(onFinishedSnapshot).not.toHaveBeenCalled()
  })

  it('结算期间缓存快照也按序号单调收敛，迟到旧包不能覆盖较新的下一局', () => {
    const { state, reconciler, setShowingResult } = setup()
    setShowingResult(true)

    expect(reconciler.apply(snapshot({ authorityEpoch: 'epoch-1', sequence: 20, round: 2 }))).toBe(false)
    expect(reconciler.apply(snapshot({ authorityEpoch: 'epoch-1', sequence: 22, round: 3 }))).toBe(false)
    expect(reconciler.apply(snapshot({ authorityEpoch: 'epoch-1', sequence: 21, round: 2, phase: 'finished', matchFinished: true }))).toBe(false)

    setShowingResult(false)
    expect(reconciler.flush()).toMatchObject({ sequence: 22, round: 3 })
    expect(state.round.value).toBe(3)
    expect(state.matchFinished.value).toBe(false)
  })
})
