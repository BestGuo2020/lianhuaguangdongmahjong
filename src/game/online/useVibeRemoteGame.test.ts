import { describe, expect, it } from 'vitest'
import {
  allLiveSeatsConfirmed,
  isFutureShuffleHand,
  isSettlementPresentationReady,
  shouldPreserveRejoinState,
  shouldPreserveSettlementConfirmationOnRejoin,
  settlementRecoveryDecision,
  shouldRecoverDowngradedSettlement,
  shouldArmAuthoritySilenceTimer,
  isShuffleStartMessage,
  liveContinuePeers,
} from './useVibeRemoteGame'

describe('liveContinuePeers（下一局确认关卡）', () => {
  it('掉线被 AI 接管的座位不再要求确认，避免卡在「等待其他玩家」', () => {
    const seatByPeer = new Map<string, number>([
      ['peer1', 1],
      ['peer2', 2],
      ['peer3', 3],
    ])
    // peer2（seat 2）掉线被 AI 接管 → 只剩 peer1/peer3 需要确认。
    expect(liveContinuePeers(seatByPeer, new Set([2]))).toEqual(['peer1', 'peer3'])
    // 无人掉线 → 全员都要确认。
    expect(liveContinuePeers(seatByPeer, new Set())).toEqual(['peer1', 'peer2', 'peer3'])
    // 掉线玩家重连恢复（seat 移出 AI 接管）→ 重新要求其确认。
    expect(liveContinuePeers(seatByPeer, new Set([1, 3]))).toEqual(['peer2'])
  })

  it('peerId 刷新后仍按原座位保留续局确认', () => {
    const liveSeats = new Map([['new-peer-1', 1], ['peer2', 2]])
    expect(allLiveSeatsConfirmed(liveSeats, new Set(), new Set([1, 2]))).toBe(true)
    expect(allLiveSeatsConfirmed(liveSeats, new Set(), new Set([2]))).toBe(false)
    expect(allLiveSeatsConfirmed(liveSeats, new Set([1]), new Set([2]))).toBe(true)
  })

  it('恢复宽限中的真人仍参与确认，只有已经 AI 接管的座位可跳过', () => {
    const boundPeers = new Map([['reconnecting-peer', 1]])
    expect(allLiveSeatsConfirmed(boundPeers, new Set(), new Set())).toBe(false)
    expect(allLiveSeatsConfirmed(boundPeers, new Set([1]), new Set())).toBe(true)
    expect(allLiveSeatsConfirmed(boundPeers, new Set(), new Set([1]))).toBe(true)
  })

  it('确认屏障不能因临时 peer 过滤而跳过未确认真人', () => {
    // hostGameRunner 的 getConfirmationSeats 会保留 reconnecting/Relay 中的 peer；
    // 只要 AI 集合没有明确该座位，下一局就必须继续等待该座位确认。
    const confirmationSeats = new Map([
      ['still-connected', 1],
      ['reconnecting-human', 2],
    ])
    expect(allLiveSeatsConfirmed(confirmationSeats, new Set(), new Set([1]))).toBe(false)
    expect(allLiveSeatsConfirmed(confirmationSeats, new Set([2]), new Set([1]))).toBe(true)
  })
})

describe('round_shuffle_start 的房主参与者映射', () => {
  const valid = {
    type: 'round_shuffle_start',
    roomId: 'ROOM01',
    round: 2,
    honba: 0,
    roundId: 'ROOM01:round:2:id',
    seats: [0, 1, 2],
    participants: [
      { seat: 0, peerId: 'host' },
      { seat: 1, peerId: 'peer1' },
      { seat: 2, peerId: 'peer2' },
    ],
    seatCount: 4,
    authorityEpoch: 'epoch-1',
  }

  it('接受完整的座位到当前 peer 映射', () => {
    expect(isShuffleStartMessage(valid)).toBe(true)
  })

  it('要求携带 honba，避免连庄洗牌被同 round 旧消息门禁误杀', () => {
    const { honba: _honba, ...withoutHonba } = valid
    expect(isShuffleStartMessage(withoutHonba)).toBe(false)
    expect(isShuffleStartMessage({ ...valid, honba: -1 })).toBe(false)
    expect(isShuffleStartMessage({ ...valid, honba: 1 })).toBe(true)
  })

  it('拒绝缺失映射、重复 peer 或未声明座位的参与者', () => {
    expect(isShuffleStartMessage({ ...valid, participants: valid.participants.slice(0, 2) })).toBe(false)
    expect(isShuffleStartMessage({
      ...valid,
      participants: [
        { seat: 0, peerId: 'host' },
        { seat: 1, peerId: 'peer1' },
        { seat: 2, peerId: 'peer1' },
      ],
    })).toBe(false)
    expect(isShuffleStartMessage({
      ...valid,
      participants: [
        { seat: 0, peerId: 'host' },
        { seat: 1, peerId: 'peer1' },
        { seat: 3, peerId: 'peer3' },
      ],
    })).toBe(false)
  })
})

describe('round_shuffle_start 的手牌新旧门禁', () => {
  it('接受同 round、honba 增加的连庄新手', () => {
    expect(isFutureShuffleHand({ round: 2, honba: 1 }, 2, 0)).toBe(true)
    expect(isFutureShuffleHand({ round: 2, honba: 0 }, 2, 0)).toBe(false)
    expect(isFutureShuffleHand({ round: 1, honba: 9 }, 2, 0)).toBe(false)
    expect(isFutureShuffleHand({ round: 3, honba: 0 }, 2, 4)).toBe(true)
  })
})

describe('胡牌后结算表现恢复判定', () => {
  it('仅在 settled 与 result 同时存在时视为弹窗已就绪', () => {
    const result = { winnerIndex: 0 }
    expect(isSettlementPresentationReady('settled', result)).toBe(true)
    expect(isSettlementPresentationReady('settled', null)).toBe(false)
    expect(isSettlementPresentationReady('revealing', result)).toBe(false)
    expect(isSettlementPresentationReady('win-effect', result)).toBe(false)
  })

  it('同一局结算曾就绪后被重进握手清空时必须恢复', () => {
    const expected = { round: 2, honba: 1 }
    expect(shouldRecoverDowngradedSettlement(
      expected, expected, 'lobby', null, true,
    )).toBe(true)
    expect(shouldRecoverDowngradedSettlement(
      expected, expected, 'revealing', null, false,
    )).toBe(false)
    expect(shouldRecoverDowngradedSettlement(
      expected, { round: 3, honba: 0 }, 'lobby', null, true,
    )).toBe(false)
    expect(shouldRecoverDowngradedSettlement(
      expected, expected, 'settled', { winnerIndex: 0 }, true,
    )).toBe(false)
  })

  it('同一局重复结算事实不能延期已启动的恢复截止时间', () => {
    const hand = { round: 4, honba: 0 }
    expect(settlementRecoveryDecision(null, hand, false, false)).toBe('start')
    expect(settlementRecoveryDecision(hand, hand, true, false)).toBe('keep')
    expect(settlementRecoveryDecision(hand, hand, false, false)).toBe('retry')
    expect(settlementRecoveryDecision(hand, hand, false, true)).toBe('idle')
    expect(settlementRecoveryDecision(hand, { round: 4, honba: 1 }, true, false)).toBe('start')
  })
})

describe('重进握手与当前阶段的消息乱序', () => {
  it('同房间当前局已落地时，迟到 rejoin_ok 不得把客户端降级回大厅', () => {
    expect(shouldPreserveRejoinState('ROOM01', 'ROOM01', 'settled', 1)).toBe(true)
    expect(shouldPreserveRejoinState('ROOM01', 'ROOM01', 'playing', 4)).toBe(true)
    expect(shouldPreserveRejoinState('ROOM01', 'ROOM01', 'lobby', 1)).toBe(false)
    expect(shouldPreserveRejoinState('ROOM01', 'ROOM02', 'settled', 1)).toBe(false)
  })

  it('已确认结算时即使 roomId 尚未写回，也不能把按钮回退成可再次确认', () => {
    expect(shouldPreserveSettlementConfirmationOnRejoin('', 'ROOM01', 'settled', 1, true)).toBe(true)
    expect(shouldPreserveSettlementConfirmationOnRejoin('ROOM01', 'ROOM01', 'settled', 1, true)).toBe(true)
    expect(shouldPreserveSettlementConfirmationOnRejoin('ROOM01', 'ROOM02', 'settled', 1, true)).toBe(false)
    expect(shouldPreserveSettlementConfirmationOnRejoin('', 'ROOM01', 'playing', 1, true)).toBe(false)
    expect(shouldPreserveSettlementConfirmationOnRejoin('', 'ROOM01', 'settled', 1, false)).toBe(false)
  })
})

describe('对局权威静默看门狗', () => {
  const playing = {
    isHost: false,
    matchFinished: false,
    phase: 'playing' as const,
    openingRunning: false,
  }

  it('正常客户端对局启用一次性静默截止时间', () => {
    expect(shouldArmAuthoritySilenceTimer(playing)).toBe(true)
  })

  it('开局动画运行期间不得把正常的长表现误判为房主静默', () => {
    expect(shouldArmAuthoritySilenceTimer({ ...playing, openingRunning: true })).toBe(false)
  })

  it('房主、大厅、结算和终局均不启用对局静默恢复', () => {
    expect(shouldArmAuthoritySilenceTimer({ ...playing, isHost: true })).toBe(false)
    expect(shouldArmAuthoritySilenceTimer({ ...playing, phase: 'lobby' })).toBe(false)
    expect(shouldArmAuthoritySilenceTimer({ ...playing, phase: 'settled' })).toBe(false)
    expect(shouldArmAuthoritySilenceTimer({ ...playing, matchFinished: true })).toBe(false)
  })
})
