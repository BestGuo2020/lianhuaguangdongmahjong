import { describe, expect, it } from 'vitest'
import { liveContinuePeers } from './useVibeRemoteGame'

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
})
