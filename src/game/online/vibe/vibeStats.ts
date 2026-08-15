// 个人战绩走 vibe.save（本人读写本人）：替代后端 match_players 聚合统计。
// 玩家对局结束后调用 updatePlayerStats 写入自己的战绩，StatsOverlay 用 getPlayerStats 读取。
// 注意：vibe.save 是「本人读写」，只能做个人战绩，做不了跨玩家全服榜。
import { getVibeClient } from './vibeClient'

export interface PlayerStats {
  matches: number
  hands: number
  wins: number
  totalDelta: number
}

const STATS_KEY = 'player-stats'

const EMPTY_STATS: PlayerStats = { matches: 0, hands: 0, wins: 0, totalDelta: 0 }

export async function getPlayerStats(): Promise<PlayerStats> {
  const client = getVibeClient()
  if (!client) return { ...EMPTY_STATS }
  const stats = await client.save.get<PlayerStats>(STATS_KEY)
  return stats ?? { ...EMPTY_STATS }
}

export async function updatePlayerStats(delta: Partial<PlayerStats>): Promise<PlayerStats> {
  const client = getVibeClient()
  if (!client) return { ...EMPTY_STATS }
  const current = await getPlayerStats()
  const next: PlayerStats = {
    matches: current.matches + (delta.matches ?? 0),
    hands: current.hands + (delta.hands ?? 0),
    wins: current.wins + (delta.wins ?? 0),
    totalDelta: current.totalDelta + (delta.totalDelta ?? 0),
  }
  await client.save.set(STATS_KEY, next)
  return next
}
