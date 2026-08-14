import { describe, expect, it, vi } from 'vitest'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import { applyFollowDealerScore, createFollowDealerTracker } from './followDealer'

function player(seat: number, score = 1000): GamePlayer {
  return {
    name: `p${seat}`, avatar: '', score, seat,
    hand: [], discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

function harness() {
  const players = [player(0), player(1), player(2), player(3)]
  const onTrigger = vi.fn()
  const tracker = createFollowDealerTracker({
    players,
    dealerIndex: () => 0,
    baseScore: 100,
    onTrigger,
  })
  return { players, onTrigger, tracker }
}

describe('跟庄（followDealer）', () => {
  it('庄家首弃后三闲家各出一张同牌 → 庄家向三家各付一底分', () => {
    const { players, onTrigger, tracker } = harness()
    expect(tracker.onDiscard(0, 'north')).toBe(false)
    expect(tracker.onDiscard(1, 'north')).toBe(false)
    expect(tracker.onDiscard(2, 'north')).toBe(false)
    expect(tracker.onDiscard(3, 'north')).toBe(true)

    expect(onTrigger).toHaveBeenCalledOnce()
    const deltas = onTrigger.mock.calls[0]![0] as Array<{ playerIndex: number; amount: number }>
    expect(deltas).toEqual([
      { playerIndex: 0, amount: -300 },
      { playerIndex: 1, amount: 100 },
      { playerIndex: 2, amount: 100 },
      { playerIndex: 3, amount: 100 },
    ])
    expect(players.map((p) => p.score)).toEqual([700, 1100, 1100, 1100])
  })

  it('任意闲家出的牌不同 → 窗口失效，不再给付', () => {
    const { players, onTrigger, tracker } = harness()
    tracker.onDiscard(0, 'north')
    tracker.onDiscard(1, 'south') // 不同牌 → 失效
    tracker.onDiscard(2, 'north')
    tracker.onDiscard(3, 'north')

    expect(onTrigger).not.toHaveBeenCalled()
    expect(players.map((p) => p.score)).toEqual([1000, 1000, 1000, 1000])
  })

  it('庄家再次出牌（第一圈未完）→ 窗口失效', () => {
    const { onTrigger, tracker } = harness()
    tracker.onDiscard(0, 'north')
    tracker.onDiscard(1, 'north')
    tracker.onDiscard(0, 'north') // 庄家又出牌
    tracker.onDiscard(2, 'north')
    tracker.onDiscard(3, 'north')

    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('同一闲家重复出牌 → 窗口失效', () => {
    const { onTrigger, tracker } = harness()
    tracker.onDiscard(0, 'north')
    tracker.onDiscard(1, 'north')
    tracker.onDiscard(1, 'north') // 重复
    tracker.onDiscard(2, 'north')
    tracker.onDiscard(3, 'north')

    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('吃/碰/杠中断后窗口失效', () => {
    const { onTrigger, tracker } = harness()
    tracker.onDiscard(0, 'north')
    tracker.onDiscard(1, 'north')
    tracker.interrupt() // 碰/杠/吃
    tracker.onDiscard(2, 'north')
    tracker.onDiscard(3, 'north')

    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('第一个出牌者不是庄家时不启动窗口', () => {
    const { onTrigger, tracker } = harness()
    tracker.onDiscard(1, 'north') // 非庄家先出，不启动
    tracker.onDiscard(2, 'north')
    tracker.onDiscard(3, 'north')
    tracker.onDiscard(0, 'north') // 庄家此时出牌，视作首弃，需重新跟三家

    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('reset 后每局重新开始', () => {
    const { onTrigger, tracker } = harness()
    tracker.onDiscard(0, 'north')
    tracker.onDiscard(1, 'north')
    tracker.reset()
    tracker.onDiscard(0, 'east') // 新局首弃
    tracker.onDiscard(1, 'east')
    tracker.onDiscard(2, 'east')
    expect(onTrigger).not.toHaveBeenCalled() // 还差一家
    expect(tracker.onDiscard(3, 'east')).toBe(true)
    expect(onTrigger).toHaveBeenCalledOnce()
  })

  it('applyFollowDealerScore 直接应用给付', () => {
    const players = [player(0), player(1), player(2), player(3)]
    const deltas = applyFollowDealerScore(players, 0, 100)
    expect(deltas).toEqual([
      { playerIndex: 0, amount: -300 },
      { playerIndex: 1, amount: 100 },
      { playerIndex: 2, amount: 100 },
      { playerIndex: 3, amount: 100 },
    ])
  })
})
