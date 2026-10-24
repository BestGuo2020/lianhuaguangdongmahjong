// 个人战绩统计（vibe.save）：对局中按「每局结算」累计本家手数/胡数/净胜分，
// 终局（房主权威 finished 快照落地、matchFinished 置 true）时一次性写入个人战绩。
//
// 为什么需要持久化到 sessionStorage：客户端在结算页刷新/断线重进后，房主会强制
// 补发同一手牌的 settled 快照（rejoin_ok → broadcastAll(true)），内存里的去重游标
// 已经丢失。把「当前房主代次 + 最后已计数手牌的 key + 累计值」按标签页存进
// sessionStorage（与 mock peerId 相同的隔离策略），重进后同 key 不重复计数。
// 跨场次隔离：authorityEpoch 每场唯一（房主引擎生命周期代次），代次变化自动从零累计。
import type { RoundResult } from '../../core/contracts/gamePort'
import type { PlayerStats } from './vibeStats'

export interface MatchHandRecord {
  /** 本地视角的 RoundResult（winnerIndex / scoreChanges 均已映射到本家=0）。 */
  result: RoundResult
  /** 当前房主引擎代次；同一代次内 (round, honba) 唯一标识一手牌。 */
  epoch: string | null
  round: number
  honba: number
}

export interface StoredMatchStats {
  epoch: string
  hands: number
  wins: number
  totalDelta: number
  /** 最近一次已计数手牌的 key（`epoch|round|honba`），用于重进后去重。 */
  lastHandKey: string
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface MatchStatsRecorderOptions {
  /** 战绩写入器：由调用方注入 vibe.save 的 updatePlayerStats，便于单测替换。 */
  writeStats: (delta: Partial<PlayerStats>) => Promise<unknown>
  getStorage?: () => StorageLike | null
  storageKey?: string
}

export const MATCH_STATS_STORAGE_KEY = 'lgm_match_stats'

function sessionStorageLike(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

export function createMatchStatsRecorder(options: MatchStatsRecorderOptions) {
  const { writeStats } = options
  const getStorage = options.getStorage ?? sessionStorageLike
  const storageKey = options.storageKey ?? MATCH_STATS_STORAGE_KEY
  let current: StoredMatchStats | null = null
  let loaded = false

  function removeStored() {
    try {
      getStorage()?.removeItem(storageKey)
    } catch {
      // 无法访问存储不应阻断对局。
    }
  }

  function persist() {
    if (!current) {
      removeStored()
      return
    }
    try {
      getStorage()?.setItem(storageKey, JSON.stringify(current))
    } catch {
      // 隐私模式/配额异常：降级为当前页面会话内的内存统计。
    }
  }

  /** 惰性恢复：刷新重进后从 sessionStorage 恢复本代次累计值；损坏/缺失按新对局从零统计。 */
  function load(): StoredMatchStats | null {
    if (loaded) return current
    loaded = true
    try {
      const raw = getStorage()?.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredMatchStats>
        if (
          typeof parsed.epoch === 'string' && parsed.epoch.length > 0
          && Number.isInteger(parsed.hands) && (parsed.hands as number) >= 0
          && Number.isInteger(parsed.wins) && (parsed.wins as number) >= 0
          && typeof parsed.totalDelta === 'number' && Number.isFinite(parsed.totalDelta)
          && typeof parsed.lastHandKey === 'string'
        ) {
          current = {
            epoch: parsed.epoch,
            hands: parsed.hands as number,
            wins: parsed.wins as number,
            totalDelta: parsed.totalDelta,
            lastHandKey: parsed.lastHandKey,
          }
          return current
        }
      }
    } catch {
      // 损坏数据按新对局处理。
    }
    current = null
    return null
  }

  return {
    /** 每局结算落地时调用：累计本家手数/胡数/净胜分（同 key 重复投递自动去重）。 */
    noteHandResult(hand: MatchHandRecord): void {
      const epoch = hand.epoch ?? ''
      const key = `${epoch}|${hand.round}|${hand.honba}`
      const stored = load()
      // 代次变化 = 新一场对局：上一场未终局的累计作废，从零开始。
      if (stored && stored.epoch !== epoch) current = null
      if (!current) {
        current = { epoch, hands: 0, wins: 0, totalDelta: 0, lastHandKey: '' }
      }
      if (current.lastHandKey === key) return
      current.lastHandKey = key
      current.hands += 1
      if (hand.result.winnerIndex === 0) current.wins += 1
      current.totalDelta += hand.result.scoreChanges?.find((change) => change.playerIndex === 0)?.delta ?? 0
      persist()
    },

    /** 终局（matchFinished 置 true）时调用：一次性写入个人战绩并清空本场累计。 */
    async flushMatch(epoch: string | null): Promise<void> {
      const stored = load()
      if (!stored || stored.epoch !== (epoch ?? '')) return
      const snapshot: StoredMatchStats = { ...stored }
      // 先清空再写入：同代次终局快照被补发（重进到终局页）时不会重复入账。
      current = null
      loaded = false
      removeStored()
      // 刷新重进后直接落到终局页的客户端没观察到任何一局结算，无从恢复手数/胡数，
      // 跳过写入，避免用「0 局」污染个人战绩。
      if (snapshot.hands < 1) return
      try {
        await writeStats({
          matches: 1,
          hands: snapshot.hands,
          wins: snapshot.wins,
          totalDelta: snapshot.totalDelta,
        })
      } catch (error) {
        console.warn('[stats] 个人战绩写入失败:', error)
      }
    },

    /** 主动退出/清理：丢弃本场未终局的累计（跨场次由代次变化自动隔离）。 */
    reset(): void {
      current = null
      loaded = false
      removeStored()
    },
  }
}
