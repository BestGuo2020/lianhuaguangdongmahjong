import { describe, expect, it } from 'vitest'
import { allLiveSeatsConfirmed, isShuffleStartMessage, liveContinuePeers } from './useVibeRemoteGame'

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
})

describe('round_shuffle_start 的房主参与者映射', () => {
  const valid = {
    type: 'round_shuffle_start',
    roomId: 'ROOM01',
    round: 2,
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
