// 回放存储：本地 IndexedDB 之上的业务封装（保留策略、失败静默降级）。
// 任何存储异常都不允许影响对局，因此所有写操作都吞掉异常并回调 onError。
import { createIndexedDbDriver, indexedDbAvailable, type ReplayStoreDriver } from './idb'
import { firstUncloneable } from './plain'
import { REPLAY_MAX_MATCHES, type ReplayMatch, type ReplayRound } from './types'

export interface ReplayStorage {
  /** 本地存储是否可用（无 IDB / 隐私模式 / 写入失败均为 false）。 */
  readonly available: boolean
  /** 当前保留上限（场）。 */
  readonly maxMatches: number
  /** 调整保留上限并立即淘汰超出的最旧场次。 */
  setMaxMatches(maxMatches: number): Promise<void>
  saveMatch(match: ReplayMatch): Promise<void>
  saveRound(round: ReplayRound): Promise<void>
  list(): Promise<ReplayMatch[]>
  loadMatch(matchId: string): Promise<ReplayMatch | null>
  loadRounds(matchId: string): Promise<ReplayRound[]>
  remove(matchId: string): Promise<void>
  clearAll(): Promise<void>
  /** 超出上限时按开始时间淘汰最旧的场次。 */
  trim(maxMatches?: number): Promise<void>
}

export interface ReplayStorageOptions {
  driver?: ReplayStoreDriver | null
  maxMatches?: number
  onError?: (error: unknown) => void
}

export function createReplayStorage(options: ReplayStorageOptions = {}): ReplayStorage {
  let maxMatches = Math.max(1, options.maxMatches ?? REPLAY_MAX_MATCHES)
  const report = (error: unknown) => { options.onError?.(error) }
  let driver: ReplayStoreDriver | null = options.driver !== undefined
    ? options.driver
    : (indexedDbAvailable() ? createIndexedDbDriver() : null)

  /** 落库前哨：把不可克隆的字段路径变成可读错误，而不是让 IndexedDB 抛一句 DataCloneError。 */
  function assertCloneable(value: unknown, label: string) {
    const bad = firstUncloneable(value)
    if (bad) throw new Error(`${label}的字段 ${bad} 不是纯数据（Vue 响应式代理无法结构化克隆）`)
  }

  async function guard<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    if (!driver) return fallback
    try {
      return await work()
    } catch (error) {
      // 写入失败（配额满 / 隐私模式 / 库被删）后不再重试，避免每局都抛异常。
      report(error)
      driver = null
      return fallback
    }
  }

  const storage: ReplayStorage = {
    get available() { return driver !== null },
    get maxMatches() { return maxMatches },
    async setMaxMatches(next) {
      maxMatches = Math.max(1, Math.floor(next) || 1)
      await storage.trim()
    },
    saveMatch(match) {
      return guard(async () => {
        assertCloneable(match, '场次记录')
        await driver!.putMatch(match)
        const all = await driver!.listMatches()
        if (all.length > maxMatches) {
          for (const stale of all.slice(maxMatches)) await driver!.deleteMatch(stale.id)
        }
      }, undefined)
    },
    saveRound(round) {
      return guard(async () => {
        assertCloneable(round, '牌谱记录')
        await driver!.putRound(round)
      }, undefined)
    },
    list() {
      return guard(async () => driver!.listMatches(), [])
    },
    loadMatch(matchId) {
      return guard(async () => driver!.getMatch(matchId), null)
    },
    loadRounds(matchId) {
      return guard(async () => driver!.listRounds(matchId), [])
    },
    remove(matchId) {
      return guard(async () => { await driver!.deleteMatch(matchId) }, undefined)
    },
    clearAll() {
      return guard(async () => { await driver!.clearAll() }, undefined)
    },
    trim(max = maxMatches) {
      return guard(async () => {
        const all = await driver!.listMatches()
        for (const stale of all.slice(max)) await driver!.deleteMatch(stale.id)
      }, undefined)
    },
  }
  return storage
}
