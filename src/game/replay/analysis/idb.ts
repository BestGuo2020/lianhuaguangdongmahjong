// 分析区的 IndexedDB 适配层（方案 §9.2、§9.3、§9.5）。
//
// 刻意使用**独立数据库**（不是往展示回放的库里加对象仓）：
// - §9.2 要求分析区独立存储、独立计费、独立清理；
// - §9.5 要求分析失败不能连带停用仍在工作的展示存储实例 → 不共用连接与守卫是最简单的实现方式；
// - 也避免为新增对象仓去动展示回放库的版本升级路径（§9.5 明确要求单独审查版本与淘汰逻辑）。
//
// 只做 open / CRUD 转发，业务逻辑在 storage.ts；单测用内存驱动顶替。
import type { AnalysisStoredStatus } from './types'

export const ANALYSIS_DB_NAME = 'lianhua-guangma-analysis'
export const ANALYSIS_DB_VERSION = 1
export const ANALYSIS_MATCH_STORE = 'matches'
export const ANALYSIS_BLOCK_STORE = 'blocks'
export const ANALYSIS_CONFIG_STORE = 'configs'

/** 落库的块：载荷是二进制（Uint8Array），不 base64、不存 Blob（§9.3）。 */
export interface AnalysisBlockRecord {
  /** 复合主键 `${matchId}#${sequence}`。 */
  id: string
  matchId: string
  sequence: number
  codec: 'gzip' | 'raw'
  rawBytes: number
  storedBytes: number
  checksum: string
  parts: number
  payload: Uint8Array
}

export type AnalysisBlockMeta = Omit<AnalysisBlockRecord, 'payload'>

export interface AnalysisGapRecord { scope: string; from?: number; to?: number; reason: string }

export interface AnalysisMatchMeta {
  matchId: string
  rulesetId: string
  createdAt: number
  updatedAt: number
  /** 最近查看／分析使用时间：淘汰顺序按它（§9.4）。后台写入不刷新它。 */
  lastViewedAt: number
  status: AnalysisStoredStatus
  parts: number
  storedBytes: number
  blockCount: number
  nextSequence: number
  gaps: AnalysisGapRecord[]
  /** 该场引用的配置 id：删除时按它释放引用计数（§9.4）。 */
  configIds: string[]
}

export interface AnalysisStoredConfig {
  id: string
  /** 引用它的场次 id 集合；空集时才回收。 */
  owners: string[]
  /** 配置或模板正文（已按版本去重）。 */
  value: unknown
  /** 落库字节（用于字节账本）。 */
  storedBytes: number
}

export interface AnalysisStoreDriver {
  /** 追加不可变块；同 (matchId, sequence) 已存在时返回 false，不覆盖（§9.3）。 */
  putBlock(record: AnalysisBlockRecord): Promise<boolean>
  listBlockMetas(matchId: string): Promise<AnalysisBlockMeta[]>
  getBlock(matchId: string, sequence: number): Promise<AnalysisBlockRecord | null>
  deleteMatchData(matchId: string): Promise<void>

  listMatchMetas(): Promise<AnalysisMatchMeta[]>
  getMatchMeta(matchId: string): Promise<AnalysisMatchMeta | null>
  putMatchMeta(meta: AnalysisMatchMeta): Promise<void>

  getConfig(id: string): Promise<AnalysisStoredConfig | null>
  putConfig(record: AnalysisStoredConfig): Promise<void>
  listConfigs(): Promise<AnalysisStoredConfig[]>
  deleteConfig(id: string): Promise<void>

  clear(): Promise<void>
  close(): void
}

export function analysisIndexedDbAvailable(): boolean {
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

export function openAnalysisDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!analysisIndexedDbAvailable()) {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const open = indexedDB.open(ANALYSIS_DB_NAME, ANALYSIS_DB_VERSION)
    open.onupgradeneeded = () => {
      const database = open.result
      if (!database.objectStoreNames.contains(ANALYSIS_BLOCK_STORE)) {
        const store = database.createObjectStore(ANALYSIS_BLOCK_STORE, { keyPath: 'id' })
        store.createIndex('matchId', 'matchId')
      }
      if (!database.objectStoreNames.contains(ANALYSIS_MATCH_STORE)) {
        database.createObjectStore(ANALYSIS_MATCH_STORE, { keyPath: 'matchId' })
      }
      if (!database.objectStoreNames.contains(ANALYSIS_CONFIG_STORE)) {
        database.createObjectStore(ANALYSIS_CONFIG_STORE, { keyPath: 'id' })
      }
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'))
    open.onblocked = () => reject(new Error('IndexedDB upgrade blocked'))
  })
}

const blockId = (matchId: string, sequence: number) => `${matchId}#${sequence}`

/** 浏览器 IndexedDB 驱动；环境不支持时返回 null。 */
export function createAnalysisIndexedDbDriver(): AnalysisStoreDriver | null {
  if (!analysisIndexedDbAvailable()) return null
  let pending: Promise<IDBDatabase> | null = null
  const database = () => (pending ??= openAnalysisDatabase())

  async function run<T>(
    stores: string | string[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const connection = await database()
    const transaction = connection.transaction(stores, mode)
    // 先挂完成回调再发请求：请求可能在 await 之前完成，晚挂会永远等不到 oncomplete。
    const done = transactionDone(transaction)
    const result = await work(transaction)
    await done
    return result
  }

  return {
    async putBlock(record) {
      return run(ANALYSIS_BLOCK_STORE, 'readwrite', async (transaction) => {
        const store = transaction.objectStore(ANALYSIS_BLOCK_STORE)
        const existing = await promisify(store.get(record.id))
        if (existing) return false   // 块不可变：已存在就不覆盖（§9.3）
        store.put(record)
        return true
      })
    },
    async listBlockMetas(matchId) {
      const all = await run(ANALYSIS_BLOCK_STORE, 'readonly', (transaction) => (
        promisify(transaction.objectStore(ANALYSIS_BLOCK_STORE).index('matchId').getAll(matchId)) as Promise<AnalysisBlockRecord[]>
      ))
      return all
        .map(({ payload: _payload, ...meta }) => meta)
        .sort((a, b) => a.sequence - b.sequence)
    },
    async getBlock(matchId, sequence) {
      const found = await run(ANALYSIS_BLOCK_STORE, 'readonly', (transaction) => (
        promisify(transaction.objectStore(ANALYSIS_BLOCK_STORE).get(blockId(matchId, sequence))) as Promise<AnalysisBlockRecord | undefined>
      ))
      return found ?? null
    },
    async deleteMatchData(matchId) {
      await run([ANALYSIS_BLOCK_STORE, ANALYSIS_MATCH_STORE], 'readwrite', async (transaction) => {
        const blockStore = transaction.objectStore(ANALYSIS_BLOCK_STORE)
        const keys = await promisify(blockStore.index('matchId').getAllKeys(matchId) as IDBRequest<IDBValidKey[]>)
        keys.forEach((key) => blockStore.delete(key))
        transaction.objectStore(ANALYSIS_MATCH_STORE).delete(matchId)
      })
    },
    async listMatchMetas() {
      const all = await run(ANALYSIS_MATCH_STORE, 'readonly', (transaction) => (
        promisify(transaction.objectStore(ANALYSIS_MATCH_STORE).getAll()) as Promise<AnalysisMatchMeta[]>
      ))
      return all.sort((a, b) => b.createdAt - a.createdAt)
    },
    async getMatchMeta(matchId) {
      const found = await run(ANALYSIS_MATCH_STORE, 'readonly', (transaction) => (
        promisify(transaction.objectStore(ANALYSIS_MATCH_STORE).get(matchId)) as Promise<AnalysisMatchMeta | undefined>
      ))
      return found ?? null
    },
    async putMatchMeta(meta) {
      await run(ANALYSIS_MATCH_STORE, 'readwrite', (transaction) => {
        transaction.objectStore(ANALYSIS_MATCH_STORE).put(meta)
      })
    },
    async getConfig(id) {
      const found = await run(ANALYSIS_CONFIG_STORE, 'readonly', (transaction) => (
        promisify(transaction.objectStore(ANALYSIS_CONFIG_STORE).get(id)) as Promise<AnalysisStoredConfig | undefined>
      ))
      return found ?? null
    },
    async putConfig(record) {
      await run(ANALYSIS_CONFIG_STORE, 'readwrite', (transaction) => {
        transaction.objectStore(ANALYSIS_CONFIG_STORE).put(record)
      })
    },
    async listConfigs() {
      return run(ANALYSIS_CONFIG_STORE, 'readonly', (transaction) => (
        promisify(transaction.objectStore(ANALYSIS_CONFIG_STORE).getAll()) as Promise<AnalysisStoredConfig[]>
      ))
    },
    async deleteConfig(id) {
      await run(ANALYSIS_CONFIG_STORE, 'readwrite', (transaction) => {
        transaction.objectStore(ANALYSIS_CONFIG_STORE).delete(id)
      })
    },
    async clear() {
      await run([ANALYSIS_BLOCK_STORE, ANALYSIS_MATCH_STORE, ANALYSIS_CONFIG_STORE], 'readwrite', (transaction) => {
        transaction.objectStore(ANALYSIS_BLOCK_STORE).clear()
        transaction.objectStore(ANALYSIS_MATCH_STORE).clear()
        transaction.objectStore(ANALYSIS_CONFIG_STORE).clear()
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
export function createAnalysisMemoryDriver(): AnalysisStoreDriver {
  const blocks = new Map<string, AnalysisBlockRecord>()
  const matches = new Map<string, AnalysisMatchMeta>()
  const configs = new Map<string, AnalysisStoredConfig>()
  const copy = <T>(value: T): T => (typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T)
  return {
    async putBlock(record) {
      if (blocks.has(record.id)) return false
      blocks.set(record.id, copy(record))
      return true
    },
    async listBlockMetas(matchId) {
      return [...blocks.values()].filter((block) => block.matchId === matchId)
        .map(({ payload: _payload, ...meta }) => copy(meta))
        .sort((a, b) => a.sequence - b.sequence)
    },
    async getBlock(matchId, sequence) {
      const found = blocks.get(blockId(matchId, sequence))
      return found ? copy(found) : null
    },
    async deleteMatchData(matchId) {
      matches.delete(matchId)
      ;[...blocks.values()].filter((block) => block.matchId === matchId).forEach((block) => blocks.delete(block.id))
    },
    async listMatchMetas() { return [...matches.values()].map(copy).sort((a, b) => b.createdAt - a.createdAt) },
    async getMatchMeta(matchId) { return matches.has(matchId) ? copy(matches.get(matchId)!) : null },
    async putMatchMeta(meta) { matches.set(meta.matchId, copy(meta)) },
    async getConfig(id) { return configs.has(id) ? copy(configs.get(id)!) : null },
    async putConfig(record) { configs.set(record.id, copy(record)) },
    async listConfigs() { return [...configs.values()].map(copy) },
    async deleteConfig(id) { configs.delete(id) },
    async clear() { blocks.clear(); matches.clear(); configs.clear() },
    close() {},
  }
}
