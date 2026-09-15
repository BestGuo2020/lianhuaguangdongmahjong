// IndexedDB 适配层：只做 open / CRUD 转发，不放业务逻辑（业务在 storage.ts）。
// 单测用 createMemoryDriver() 顶替，避免引入 fake-indexeddb 依赖。
import type { ReplayMatch, ReplayRound } from './types'

export const REPLAY_DB_NAME = 'lianhua-guangma-replay'
export const REPLAY_DB_VERSION = 1
export const REPLAY_MATCH_STORE = 'matches'
export const REPLAY_ROUND_STORE = 'rounds'

export interface ReplayStoreDriver {
  putMatch(match: ReplayMatch): Promise<void>
  putRound(round: ReplayRound): Promise<void>
  getMatch(id: string): Promise<ReplayMatch | null>
  listMatches(): Promise<ReplayMatch[]>
  listRounds(matchId: string): Promise<ReplayRound[]>
  countMatches(): Promise<number>
  deleteMatch(id: string): Promise<void>
  clearAll(): Promise<void>
  close(): void
}

export function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export function openReplayDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!indexedDbAvailable()) {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const open = indexedDB.open(REPLAY_DB_NAME, REPLAY_DB_VERSION)
    open.onupgradeneeded = () => {
      const database = open.result
      if (!database.objectStoreNames.contains(REPLAY_MATCH_STORE)) {
        const store = database.createObjectStore(REPLAY_MATCH_STORE, { keyPath: 'id' })
        store.createIndex('startedAt', 'startedAt')
        store.createIndex('rulesetId', 'rulesetId')
        store.createIndex('status', 'status')
      }
      if (!database.objectStoreNames.contains(REPLAY_ROUND_STORE)) {
        const store = database.createObjectStore(REPLAY_ROUND_STORE, { keyPath: 'id' })
        store.createIndex('matchId', 'matchId')
      }
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'))
    open.onblocked = () => reject(new Error('IndexedDB upgrade blocked'))
  })
}

/** 浏览器 IndexedDB 驱动；环境不支持时返回 null。 */
export function createIndexedDbDriver(): ReplayStoreDriver | null {
  if (!indexedDbAvailable()) return null
  let pending: Promise<IDBDatabase> | null = null
  const database = () => (pending ??= openReplayDatabase())

  async function run<T>(
    stores: string | string[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const connection = await database()
    const transaction = connection.transaction(stores, mode)
    // 先挂完成回调再发请求：请求可能在 await 之前就完成，晚挂会永远等不到 oncomplete。
    const done = transactionDone(transaction)
    const result = await work(transaction)
    await done
    return result
  }

  return {
    async putMatch(match) {
      await run(REPLAY_MATCH_STORE, 'readwrite', (transaction) => {
        transaction.objectStore(REPLAY_MATCH_STORE).put(match)
      })
    },
    async putRound(round) {
      await run(REPLAY_ROUND_STORE, 'readwrite', (transaction) => {
        transaction.objectStore(REPLAY_ROUND_STORE).put(round)
      })
    },
    async getMatch(id) {
      return run(REPLAY_MATCH_STORE, 'readonly', async (transaction) => (
        await promisify(transaction.objectStore(REPLAY_MATCH_STORE).get(id)) as ReplayMatch | undefined
      ) ?? null)
    },
    async listMatches() {
      const all = await run(REPLAY_MATCH_STORE, 'readonly', (transaction) => (
        promisify(transaction.objectStore(REPLAY_MATCH_STORE).getAll()) as Promise<ReplayMatch[]>
      ))
      return all.sort((a, b) => b.startedAt - a.startedAt)
    },
    async listRounds(matchId) {
      const all = await run(REPLAY_ROUND_STORE, 'readonly', (transaction) => (
        promisify(
          transaction.objectStore(REPLAY_ROUND_STORE).index('matchId').getAll(matchId),
        ) as Promise<ReplayRound[]>
      ))
      return all.sort((a, b) => a.roundIndex - b.roundIndex)
    },
    async countMatches() {
      return run(REPLAY_MATCH_STORE, 'readonly', (transaction) => (
        promisify(transaction.objectStore(REPLAY_MATCH_STORE).count())
      ))
    },
    async deleteMatch(id) {
      await run([REPLAY_MATCH_STORE, REPLAY_ROUND_STORE], 'readwrite', async (transaction) => {
        const roundStore = transaction.objectStore(REPLAY_ROUND_STORE)
        const keys = await promisify(roundStore.index('matchId').getAllKeys(id) as IDBRequest<IDBValidKey[]>)
        keys.forEach((key) => roundStore.delete(key))
        transaction.objectStore(REPLAY_MATCH_STORE).delete(id)
      })
    },
    async clearAll() {
      await run([REPLAY_MATCH_STORE, REPLAY_ROUND_STORE], 'readwrite', (transaction) => {
        transaction.objectStore(REPLAY_MATCH_STORE).clear()
        transaction.objectStore(REPLAY_ROUND_STORE).clear()
      })
    },
    close() {
      if (!pending) return
      void pending.then((connection) => connection.close()).catch(() => {})
      pending = null
    },
  }
}

/** 内存驱动：单测与无 IDB 环境下的兜底（语义与 IDB 一致：存取均为结构化克隆副本）。 */
export function createMemoryDriver(): ReplayStoreDriver {
  const matches = new Map<string, ReplayMatch>()
  const rounds = new Map<string, ReplayRound>()
  const copy = <T>(value: T): T => (typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T)
  return {
    async putMatch(match) { matches.set(match.id, copy(match)) },
    async putRound(round) { rounds.set(round.id, copy(round)) },
    async getMatch(id) { return matches.has(id) ? copy(matches.get(id)!) : null },
    async listMatches() { return [...matches.values()].map(copy).sort((a, b) => b.startedAt - a.startedAt) },
    async listRounds(matchId) {
      return [...rounds.values()].filter((round) => round.matchId === matchId).map(copy)
        .sort((a, b) => a.roundIndex - b.roundIndex)
    },
    async countMatches() { return matches.size },
    async deleteMatch(id) {
      matches.delete(id)
      ;[...rounds.values()].filter((round) => round.matchId === id).forEach((round) => rounds.delete(round.id))
    },
    async clearAll() { matches.clear(); rounds.clear() },
    close() {},
  }
}
