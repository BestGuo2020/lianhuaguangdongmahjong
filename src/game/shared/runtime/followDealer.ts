// 「跟庄」规则：开局第一圈，庄家打出的第一张牌，三个闲家在第一圈各出一张同牌，
// 则庄家向其他三家各给付一个底分（不影响牌局进行）。
// 窗口失效：闲家出牌不同 / 庄家再次出牌 / 同一闲家重复出牌 / 发生吃、碰、杠等打断动作。
import type { GamePlayer, ScoreDelta, TileType } from '../../core/contracts/types'

export interface FollowDealerTracker {
  /** 每次正常出牌后调用；触发跟庄给付时返回 true（由 onTrigger 完成给付展示）。 */
  onDiscard(playerIndex: number, tile: TileType): boolean
  /** 吃/碰/杠等打断第一圈的动作发生时调用，窗口立即失效。 */
  interrupt(): void
  /** 每局开局时重置。 */
  reset(): void
}

export interface FollowDealerTrackerOptions {
  players: GamePlayer[]
  dealerIndex(): number
  baseScore: number
  onTrigger(deltas: ScoreDelta[]): void
}

export function createFollowDealerTracker(options: FollowDealerTrackerOptions): FollowDealerTracker {
  const { players, dealerIndex, baseScore, onTrigger } = options
  let started = false
  let active = false
  let tile: TileType | null = null
  const followed: number[] = []

  function onDiscard(playerIndex: number, discarded: TileType): boolean {
    if (!started) {
      // 开局第一张出牌者必须是庄家（首弃），进入跟庄窗口。
      if (playerIndex !== dealerIndex()) return false
      started = true
      active = true
      tile = discarded
      followed.length = 0
      return false
    }
    if (!active) return false
    if (playerIndex === dealerIndex() || followed.includes(playerIndex) || discarded !== tile) {
      active = false
      return false
    }
    followed.push(playerIndex)
    if (followed.length === 3) {
      active = false
      onTrigger(applyFollowDealerScore(players, dealerIndex(), baseScore))
      return true
    }
    return false
  }

  function interrupt() {
    active = false
  }

  function reset() {
    started = false
    active = false
    tile = null
    followed.length = 0
  }

  return { onDiscard, interrupt, reset }
}

/** 庄家向其他三家各付一个底分：庄家 −3B，三家各 +1B。 */
export function applyFollowDealerScore(
  players: GamePlayer[],
  dealerIndex: number,
  baseScore: number,
): ScoreDelta[] {
  players[dealerIndex].score -= baseScore * 3
  const deltas: ScoreDelta[] = [{ playerIndex: dealerIndex, amount: -baseScore * 3 }]
  players.forEach((player, index) => {
    if (index === dealerIndex) return
    player.score += baseScore
    deltas.push({ playerIndex: index, amount: baseScore })
  })
  return deltas
}
