// 分析区存储（方案 §9.2、§9.3、§9.4、§9.5）。
//
// 与展示回放存储（../storage.ts）的关系：
// - 独立数据库、独立驱动、**独立失败域**：分析侧的写入失败只停用分析侧，绝不影响展示回放的读写（§9.5）。
// - 生命周期绑定场次：展示回放被裁掉后，其分析块同步删除（§9.2），由 reconcileLifecycle() 执行。
// - 读取依赖展示回放提供公开字段（§9.3），因此不建立"展示回放已删、分析区仍悬空"的状态。
//
// 本模块不产生任何"必须成功"的副作用：所有对外方法都不抛错，失败只降级并记录缺失（§9.4、§9.5）。
import {
  createAnalysisBlockWriter,
  decodeAnalysisBlock,
  mayStoreRawBlock,
  utf8Bytes,
  type AnalysisBlockPart,
} from './codec'
import type {
  AnalysisAreaStatus, AnalysisCompleteness,
} from './types'
import {
  createAnalysisIndexedDbDriver,
  createAnalysisMemoryDriver,
  type AnalysisBlockMeta,
  type AnalysisGapRecord,
  type AnalysisMatchMeta,
  type AnalysisStoredConfig,
  type AnalysisStoreDriver,
} from './idb'

/** 默认字节预算：可配置软上限候选，正式默认值待设备实测确定（§9.4）。 */
export const ANALYSIS_DEFAULT_BUDGET_BYTES = 200 * 1024 * 1024
/** 压缩不可用时允许落库的 raw 字节上限（按场累计）。 */
export const ANALYSIS_DEFAULT_RAW_BUDGET_BYTES = 8 * 1024 * 1024

export interface AnalysisStorageOptions {
  driver?: AnalysisStoreDriver | null
  maxBytes?: number
  rawBudgetBytes?: number
  now?: () => number
  onError?: (detail: string) => void
}

/** 写入失败原因。 */
export type AnalysisWriteFailure = 'unavailable' | 'budget' | 'raw-budget' | 'empty'

/**
 * 写入结果：单一形状（不用判别联合）——本工具链对 await 之后的联合收窄不可靠。
 * ok=false 时 reason 必填，ok=true 时 reason 为 null。
 */
export interface AnalysisWriteResult {
  ok: boolean
  reason: AnalysisWriteFailure | null
  storedBytes: number
  blocks: number
  paused: boolean
}

export interface AnalysisStorage {
  /** 分析区是否可用（浏览器不支持、驱动缺失或已因失败停用时为 false）。 */
  available(): boolean
  /**
   * 追加一批记录：内部按 32–64KiB 分批 → 压缩 → 不可变追加。
   * 预算不足或 raw 超限时**不落库**并留痕，不抛错、不阻塞调用方（§9.3、§9.4）。
   */
  write(matchId: string, info: { rulesetId: string }, parts: AnalysisBlockPart[]): Promise<AnalysisWriteResult>
  /** 读取某场全部分析记录（按块序号拼装；块缺失/坏块时给出不完整标记）。 */
  read(matchId: string): Promise<{ parts: AnalysisBlockPart[]; meta: AnalysisMatchMeta | null; complete: boolean; reason?: string }>
  status(matchId: string): Promise<AnalysisAreaStatus>
  /** 登记/续期配置引用：同一版本配置被多场共享时只存一份，零引用才回收（§9.4）。 */
  retainConfig(matchId: string, config: { id: string; value: unknown }): Promise<void>
  readConfigs(matchId: string): Promise<unknown[]>
  /** 标记"最近查看"：只有明确操作会调用它；后台写入不刷新（§9.4）。 */
  markViewed(matchId: string): Promise<void>
  /** 单独删除分析区、保留展示回放；留下"已删除"墓碑供列表显示（§9.2）。 */
  removeAnalysis(matchId: string): Promise<void>
  /** 展示回放已不存在的场次，其分析区同步删除（§9.2）；返回被清理的场次。 */
  reconcileLifecycle(existingMatchIds: string[]): Promise<string[]>
  /** 按 §9.4 顺序淘汰：分析区优先、按最近查看时间、受保护场次不动。 */
  evictToBudget(options?: { budgetBytes?: number; protect?: string[] }): Promise<{ removed: string[]; freedBytes: number }>
  usage(): Promise<{ bytes: number; matches: number }>
  setBudget(bytes: number): void
  budget(): number
  /** 记录缺失范围与原因（容量／队列／写入失败都必须留痕，§9.5）。 */
  noteGap(matchId: string, gap: AnalysisGapRecord): Promise<void>
  close(): void
}

function emptyMeta(matchId: string, rulesetId: string, at: number): AnalysisMatchMeta {
  return {
    matchId, rulesetId, createdAt: at, updatedAt: at, lastViewedAt: at,
    status: 'complete', parts: 0, storedBytes: 0, blockCount: 0, nextSequence: 1, gaps: [], configIds: [],
  }
}

/**
 * 创建分析区存储。
 * 传入 driver 便于单测；未传时使用 IndexedDB（环境不支持则不可用，所有方法安全空转）。
 */
export function createAnalysisStorage(options: AnalysisStorageOptions = {}): AnalysisStorage {
  const now = options.now ?? (() => Date.now())
  let driver: AnalysisStoreDriver | null = options.driver === undefined
    ? createAnalysisIndexedDbDriver()
    : options.driver
  let maxBytes = Math.max(0, options.maxBytes ?? ANALYSIS_DEFAULT_BUDGET_BYTES)
  const rawBudgetBytes = Math.max(0, options.rawBudgetBytes ?? ANALYSIS_DEFAULT_RAW_BUDGET_BYTES)
  let broken = false
  /** 因预算/raw 限制而暂停的场次：暂停后不再尝试写入，只继续展示回放（§9.3、§9.4）。 */
  const paused = new Set<string>()

  function report(detail: string) {
    try { options.onError?.(detail) } catch { /* 失败通知自身也必须安全（§9.5） */ }
  }

  /** 所有驱动调用的统一守卫：不抛错、失败即停用本实例，并通知一次（§9.5）。 */
  async function guard<T>(label: string, run: (driver: AnalysisStoreDriver) => Promise<T>, fallback: T): Promise<T> {
    if (!driver || broken) return fallback
    try {
      return await run(driver)
    } catch (error) {
      broken = true
      const detail = `${label} 失败：${String(error).slice(0, 160)}`
      report(detail)
      // 只停用分析侧；展示回放存储是另一个实例，不受影响（§9.5）
      return fallback
    }
  }

  const readMeta = (matchId: string) => guard('读取分析元数据', (d) => d.getMatchMeta(matchId), null)
  const putMeta = (meta: AnalysisMatchMeta) => guard('写入分析元数据', async (d) => { await d.putMatchMeta(meta) }, undefined)

  /** 释放某场持有的配置引用；零引用时回收（§9.4）。 */
  async function releaseConfigs(matchId: string, configIds: string[]) {
    for (const id of configIds) {
      await guard('释放配置引用', async (d) => {
        const config = await d.getConfig(id)
        if (!config) return
        const owners = config.owners.filter((owner) => owner !== matchId)
        if (owners.length) await d.putConfig({ ...config, owners })
        else await d.deleteConfig(id)
      }, undefined)
    }
  }

  async function totalBytes(): Promise<number> {
    return guard('统计分析区字节', async (d) => {
      const metas = await d.listMatchMetas()
      return metas.reduce((sum, meta) => sum + meta.storedBytes, 0)
    }, 0)
  }

  /** 按 §9.4 顺序淘汰：分析区优先、按最近查看时间、受保护场次不动。 */
  async function evictToBudget(options2: { budgetBytes?: number; protect?: string[] } = {}) {
    const budget = Math.max(0, options2.budgetBytes ?? maxBytes)
    const protect = new Set(options2.protect ?? [])
    let used = await totalBytes()
    if (used <= budget) return { removed: [] as string[], freedBytes: 0 }
    const metas: AnalysisMatchMeta[] = await guard('列出分析元数据', (d) => d.listMatchMetas(), [])
    // §9.4 顺序：分析区优先、按最近查看／分析使用时间淘汰、不动受保护与正在写入的场次
    const candidates = metas
      .filter((meta) => meta.status !== 'deleted' && meta.storedBytes > 0 && !protect.has(meta.matchId))
      .sort((a, b) => a.lastViewedAt - b.lastViewedAt || a.createdAt - b.createdAt)
    const removed: string[] = []
    let freedBytes = 0
    for (const meta of candidates) {
      if (used <= budget) break
      await releaseConfigs(meta.matchId, meta.configIds)
      await guard('淘汰分析数据', (d) => d.deleteMatchData(meta.matchId), undefined)
      paused.delete(meta.matchId)
      used -= meta.storedBytes
      freedBytes += meta.storedBytes
      removed.push(meta.matchId)
    }
    return { removed, freedBytes }
  }

  return {
    available() { return Boolean(driver) && !broken },

    async write(matchId, info, parts) {
      if (!driver || broken || !parts.length) {
        const reason: AnalysisWriteFailure = broken || !driver ? 'unavailable' : 'empty'
        return { ok: false, reason, storedBytes: 0, blocks: 0, paused: paused.has(matchId) }
      }
      if (paused.has(matchId)) return { ok: false, reason: 'budget', storedBytes: 0, blocks: 0, paused: true }

      let meta = await readMeta(matchId) ?? emptyMeta(matchId, info.rulesetId, now())
      const writer = createAnalysisBlockWriter()
      let storedBytes = 0
      let blocks = 0

      for (const part of parts) {
        writer.push(part)
        // 按目标字节分批：达到目标就刷一块（压缩在写事务之前完成，见 codec）
        if (!writer.shouldFlush()) continue
        const outcome = await flushBlock(writer, meta)
        if (outcome.failure) return outcome.failure
        storedBytes += outcome.storedBytes
        blocks += outcome.blocks
        meta = outcome.meta
      }
      const tail = await flushBlock(writer, meta)
      if (tail.failure) return tail.failure
      storedBytes += tail.storedBytes
      blocks += tail.blocks

      const updated: AnalysisMatchMeta = {
        ...tail.meta,
        updatedAt: now(),
      }
      await putMeta(updated)
      return { ok: true, reason: null, storedBytes, blocks, paused: false }

      /**
       * 刷一块：先做预算与 raw 判定，再不可变追加；任一步失败即留痕并暂停该场。
       * 返回单一形状（不用判别联合）：本工具链对 await 之后的联合收窄不可靠。
       */
      async function flushBlock(
        target: ReturnType<typeof createAnalysisBlockWriter>,
        current: AnalysisMatchMeta,
      ): Promise<{ meta: AnalysisMatchMeta; storedBytes: number; blocks: number; failure: AnalysisWriteResult | null }> {
        const block = await target.flush(current.nextSequence)
        if (!block) return { meta: current, storedBytes: 0, blocks: 0, failure: null }

        // 压缩不可用/失败时退化为 raw：**只有 raw 块**才受 raw 预算限制（§9.3）
        if (block.codec === 'raw' && !mayStoreRawBlock(block, { rawBudgetBytes })) {
          paused.add(matchId)
          const gap: AnalysisGapRecord = { scope: 'analysis', reason: 'raw-block-over-budget' }
          const next: AnalysisMatchMeta = {
            ...current, status: 'partial' as AnalysisCompleteness, updatedAt: now(), gaps: [...current.gaps, gap],
          }
          await putMeta(next)
          return { meta: next, storedBytes: 0, blocks: 0, failure: { ok: false, reason: 'raw-budget', storedBytes: 0, blocks: 0, paused: true } }
        }
        // 字节预算：先按 §9.4 顺序淘汰其它分析区，再决定是否暂停本场
        const used = await totalBytes()
        if (used + block.storedBytes > maxBytes) {
          await evictToBudget({ protect: [matchId] })
          const after = await totalBytes()
          if (after + block.storedBytes > maxBytes) {
            paused.add(matchId)
            const gap: AnalysisGapRecord = { scope: 'analysis', reason: 'budget-exceeded' }
            const next: AnalysisMatchMeta = {
              ...current, status: 'partial' as AnalysisCompleteness, updatedAt: now(), gaps: [...current.gaps, gap],
            }
            await putMeta(next)
            return { meta: next, storedBytes: 0, blocks: 0, failure: { ok: false, reason: 'budget', storedBytes: 0, blocks: 0, paused: true } }
          }
        }

        const appended = await guard('追加分析块', (d) => d.putBlock({
          id: `${matchId}#${block.sequence}`,
          matchId,
          sequence: block.sequence,
          codec: block.codec,
          rawBytes: block.rawBytes,
          storedBytes: block.storedBytes,
          checksum: block.checksum,
          parts: block.parts,
          payload: block.payload,
        }), false)
        if (!appended) {
          // 驱动失败（已停用）或序号已被占用：都算这一块没落成功，留痕并暂停本场（§9.5）
          const reason = broken ? 'write-failed' : 'sequence-occupied'
          paused.add(matchId)
          const next: AnalysisMatchMeta = {
            ...current, status: 'partial' as AnalysisCompleteness, updatedAt: now(),
            gaps: [...current.gaps, { scope: 'analysis', reason, from: block.sequence }],
          }
          await putMeta(next)
          return { meta: next, storedBytes: 0, blocks: 0, failure: { ok: false, reason: broken ? 'unavailable' : 'budget', storedBytes: 0, blocks: 0, paused: true } }
        }

        const next: AnalysisMatchMeta = {
          ...current,
          nextSequence: current.nextSequence + 1,
          parts: current.parts + block.parts,
          storedBytes: current.storedBytes + block.storedBytes,
          blockCount: current.blockCount + 1,
          updatedAt: now(),
        }
        await putMeta(next)
        return { meta: next, storedBytes: block.storedBytes, blocks: 1, failure: null }
      }
    },

    async read(matchId) {
      const meta = await readMeta(matchId)
      if (!meta) return { parts: [], meta: null, complete: false, reason: 'no-analysis' }
      const metas: AnalysisBlockMeta[] = await guard('列出分析块', (d) => d.listBlockMetas(matchId), [])
      const parts: AnalysisBlockPart[] = []
      for (const blockMeta of metas) {
        const record = await guard('读取分析块', (d) => d.getBlock(matchId, blockMeta.sequence), null)
        if (!record) return { parts, meta, complete: false, reason: 'block-missing' }
        const decoded = await decodeAnalysisBlock({
          sequence: record.sequence, codec: record.codec, rawBytes: record.rawBytes,
          storedBytes: record.storedBytes, checksum: record.checksum, parts: record.parts, payload: record.payload,
        })
        if (decoded.error || !decoded.parts) return { parts, meta, complete: false, reason: decoded.error ?? 'parse-failed' }
        parts.push(...decoded.parts)
      }
      const complete = meta.status === 'complete' && metas.length === meta.blockCount
      return { parts, meta, complete, ...(complete ? {} : { reason: 'incomplete' }) }
    },

    async status(matchId) {
      if (!driver || broken) return 'disabled'
      const meta = await readMeta(matchId)
      if (!meta) return 'disabled'
      return meta.status
    },

    async retainConfig(matchId, config) {
      await guard('登记配置引用', async (d) => {
        const existing = await d.getConfig(config.id)
        if (existing) {
          if (!existing.owners.includes(matchId)) await d.putConfig({ ...existing, owners: [...existing.owners, matchId] })
        } else {
          await d.putConfig({
            id: config.id, owners: [matchId], value: config.value,
            storedBytes: utf8Bytes(JSON.stringify(config.value)),
          })
        }
        // 无论配置是否已存在，都要把 id 记进本场清单：否则读取侧按清单取不到共享配置
        // （§9.4 的「A、B 两场共享模板」场景就是靠这条闭合引用）。
        const meta = await d.getMatchMeta(matchId)
        if (meta && !meta.configIds.includes(config.id)) {
          await d.putMatchMeta({ ...meta, configIds: [...meta.configIds, config.id] })
        }
      }, undefined)
    },

    async readConfigs(matchId) {
      const meta = await readMeta(matchId)
      if (!meta) return []
      const configs: AnalysisStoredConfig[] = await guard('读取配置区', (d) => d.listConfigs(), [])
      const wanted = new Set(meta.configIds)
      return configs.filter((config) => wanted.has(config.id)).map((config) => config.value)
    },

    async markViewed(matchId) {
      const meta = await readMeta(matchId)
      if (!meta) return
      if (meta.status === 'deleted') return
      await putMeta({ ...meta, lastViewedAt: now() })
    },

    async removeAnalysis(matchId) {
      const meta = await readMeta(matchId)
      if (!meta) return
      await guard('删除分析数据', (d) => d.deleteMatchData(matchId), undefined)
      await releaseConfigs(matchId, meta.configIds)
      paused.delete(matchId)
      // 留墓碑：列表要能显示「已删除」，且不再计入字节账本（§9.2）
      await putMeta({ ...meta, status: 'deleted', parts: 0, storedBytes: 0, blockCount: 0, nextSequence: 1, gaps: [], configIds: [], updatedAt: now() })
    },

    async reconcileLifecycle(existingMatchIds) {
      const existing = new Set(existingMatchIds)
      const metas: AnalysisMatchMeta[] = await guard('列出分析元数据', (d) => d.listMatchMetas(), [])
      const removed: string[] = []
      for (const meta of metas) {
        if (existing.has(meta.matchId)) continue
        // 展示回放已不在：分析区不得比它活得更久（§9.2）
        await releaseConfigs(meta.matchId, meta.configIds)
        await guard('清理悬空分析', (d) => d.deleteMatchData(meta.matchId), undefined)
        paused.delete(meta.matchId)
        removed.push(meta.matchId)
      }
      return removed
    },

    async evictToBudget(options2 = {}) {
      return evictToBudget(options2)
    },

    async usage() {
      const metas: AnalysisMatchMeta[] = await guard('列出分析元数据', (d) => d.listMatchMetas(), [])
      return {
        bytes: metas.reduce((sum, meta) => sum + meta.storedBytes, 0),
        matches: metas.filter((meta) => meta.status !== 'deleted').length,
      }
    },

    setBudget(bytes) { maxBytes = Math.max(0, bytes) },
    budget() { return maxBytes },

    async noteGap(matchId, gap) {
      const meta = await readMeta(matchId)
      if (!meta) return
      await putMeta({
        ...meta,
        status: meta.status === 'deleted' ? 'deleted' : 'partial',
        gaps: [...meta.gaps, gap],
        updatedAt: now(),
      })
    },

    close() {
      try { driver?.close() } catch { /* 关闭失败无需上报 */ }
      driver = null
    },
  }
}

/** 无 IDB 环境下的兜底实例（内存）：便于测试与"分析关闭"路径复用同一接口。 */
export function createAnalysisMemoryStorage(options: Omit<AnalysisStorageOptions, 'driver'> = {}): AnalysisStorage {
  return createAnalysisStorage({ ...options, driver: createAnalysisMemoryDriver() })
}
