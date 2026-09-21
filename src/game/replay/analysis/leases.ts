// 跨标签页的字节预算预留（方案 §9.4）。
//
// 设计原文的要点：「同一浏览器配置文件、同一存储分区内的同源多标签页共享存储预算；不能只测单页……
// 预算预留、提交记账、释放和清理应跨实例协调，不能只靠内存锁或各页自己的计数」，
// 并且必须能处理「关闭一页后恢复遗留预留」。
//
// 做法：把**在途写入的预留**放在 `localStorage`（同源共享、无需给分析库加表与迁移），
// 键是"来源实例 id → { 字节, 时间戳 }"。每个实例在录制期间定时心跳刷新自己的时间戳；
// 超过 `ttlMs` 没心跳的预留视为那一页已经走了，读取时顺手回收（这就是"恢复遗留预留"）。
//
// 边界（不夸大）：预留只覆盖**在途**字节，用于避免两页各自判断"没超限"后同时写满；
// 真正落库仍是各自的事务，跨页的最终一致性靠"写入前重新读取账本 + 预留"两次检查来降低竞争窗口，
// 不做分布式锁。浏览器配额信号（estimate()）只辅助下调预算，不参与这里的判断。

export interface BudgetLeaseOptions {
  /** 共享状态读写（默认 localStorage；不可用时退化为内存，即单实例语义）。 */
  load?: () => string | null
  save?: (value: string) => void
  now?: () => number
  /** 本实例 id（默认随机；测试可注入）。 */
  instanceId?: string
  /** 多久没心跳就算这一页已经走了（默认 30s）。 */
  ttlMs?: number
  /** 心跳间隔（默认 10s）。 */
  heartbeatMs?: number
  /** 定时器注入（单测用）。 */
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface BudgetLease {
  /** 其它标签页当前在途的预留字节合计（已顺手回收过期项）。 */
  othersReserved(): number
  /** 取一份预留（同一实例同一时刻只有一份，新的覆盖旧的）。 */
  reserve(bytes: number): void
  /** 释放本实例的预留（写入结束、失败、暂停或关闭时都要调用）。 */
  release(): void
  /**
   * 淘汰令牌：同一时刻只允许一个实例做淘汰（§9.4「清理应跨实例协调」）。
   * 拿不到就说明别的标签页正在淘汰 —— 调用方应让路（稍后重查账本），而不是各删各的。
   */
  tryAcquireEviction(): boolean
  releaseEviction(): void
  /** 录制期间保活：定时刷新自己的时间戳，让别的标签页知道这页还活着。 */
  startHeartbeat(): void
  stopHeartbeat(): void
  snapshot(): { instanceId: string; self: number; others: number; liveInstances: string[]; evictor: string | null }
}

const LEASE_KEY = 'lgm_analysis_budget_leases'
/** 淘汰令牌在共享状态里的保留键（不是实例 id，故不会被当成"别的标签页在途预留"）。 */
const EVICTOR_KEY = '__evictor'
/** 令牌记录用的哨兵字节值（与真实预留区分，便于识别）。 */
const EVICTION_TOKEN = -1

interface LeaseRecord { bytes: number; at: number; /** 淘汰令牌专用：持有者实例 id。 */ holder?: string }

function defaultLoad(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(LEASE_KEY)
  } catch {
    return null
  }
}

function defaultSave(value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LEASE_KEY, value)
  } catch {
    /* 隐私模式写不进去：退化为单实例语义，不影响录制 */
  }
}

function defaultId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `lease-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function createBudgetLease(options: BudgetLeaseOptions = {}): BudgetLease {
  const load = options.load ?? defaultLoad
  const save = options.save ?? defaultSave
  const now = options.now ?? (() => Date.now())
  const instanceId = options.instanceId ?? defaultId()
  const ttlMs = Math.max(1_000, options.ttlMs ?? 30_000)
  const heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 10_000)
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setInterval(run, ms))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  let heartbeat: unknown = null

  /** 读全部预留并**顺手回收过期项**（关闭的那一页留下的预留就在这一步被释放）。 */
  function read(): Record<string, LeaseRecord> {
        const parsed: Record<string, LeaseRecord> = {}
    try {
      const raw = load()
      if (raw) {
        const value = JSON.parse(raw) as Record<string, LeaseRecord>
        for (const [id, record] of Object.entries(value)) {
          if (!record || typeof record.bytes !== 'number' || typeof record.at !== 'number') continue
          // 淘汰令牌可能是负数（哨兵），预留字节一律非负；持有者字段要保留，否则无法判断"谁在淘汰"
          parsed[id] = {
            bytes: id === EVICTOR_KEY ? record.bytes : Math.max(0, record.bytes),
            at: record.at,
            ...(typeof record.holder === 'string' ? { holder: record.holder } : {}),
          }
        }
      }
    } catch {
      /* 坏数据按"没有预留"处理；淘汰令牌也一样，不至于永久卡住 */
    }
    const at = now()
    const live: Record<string, LeaseRecord> = {}
    let reclaimed = false
    for (const [id, record] of Object.entries(parsed)) {
      if (id !== instanceId && at - record.at > ttlMs) { reclaimed = true; continue }
      live[id] = record
    }
    if (reclaimed) write(live)
    return live
  }

  function write(records: Record<string, LeaseRecord>): void {
    try {
      save(JSON.stringify(records))
    } catch {
      /* 记不住就退化为单实例语义 */
    }
  }

function snapshot(): { instanceId: string; self: number; others: number; liveInstances: string[]; evictor: string | null } {
    const records = read()
    const others = Object.entries(records).filter(([id]) => id !== instanceId && id !== EVICTOR_KEY)
    return {
      instanceId,
      self: records[instanceId]?.bytes ?? 0,
      others: others.reduce((total, [, record]) => total + record.bytes, 0),
      liveInstances: others.map(([id]) => id),
      evictor: records[EVICTOR_KEY]?.holder ?? null,
    }
  }

  return {
    othersReserved() {
      return snapshot().others
    },
    reserve(bytes) {
      const records = read()
      records[instanceId] = { bytes: Math.max(0, Math.ceil(bytes)), at: now() }
      write(records)
    },
    release() {
      const records = read()
      if (records[instanceId]) {
        delete records[instanceId]
        write(records)
      }
    },
    /**
     * 淘汰令牌：用同一个共享状态里的保留键（`__evictor`）表示"谁在淘汰"，
     * 时间戳沿用同一套 ttl —— 那一页崩了/被关了，令牌也会自己过期，不会永久卡住别的页。
     */
    tryAcquireEviction() {
      const records = read()
      const token = records[EVICTOR_KEY]
      // 别人正持有（且没过期：过期项在上面的 read() 里已经被回收）⇒ 让路
      if (token && token.holder && token.holder !== instanceId) return false
      records[EVICTOR_KEY] = { bytes: EVICTION_TOKEN, at: now(), holder: instanceId }
      write(records)
      return true
    },
    releaseEviction() {
      const records = read()
      if (records[EVICTOR_KEY]?.holder === instanceId) {
        delete records[EVICTOR_KEY]
        write(records)
      }
    },
    startHeartbeat() {
      if (heartbeat !== null) return
      heartbeat = setTimer(() => {
        const records = read()
        const self = records[instanceId]
        if (!self) return
        records[instanceId] = { bytes: self.bytes, at: now() }
        write(records)
      }, heartbeatMs)
    },
    stopHeartbeat() {
      if (heartbeat === null) return
      clearTimer(heartbeat)
      heartbeat = null
    },
    snapshot,
  }
}

/** 无人共享存储时的空实现（例如无 DOM 环境的测试）：语义是"没有别的实例"。 */
export function createNoopBudgetLease(): BudgetLease {
  return {
    othersReserved: () => 0,
    reserve: () => {},
    release: () => {},
    tryAcquireEviction: () => true,
    releaseEviction: () => {},
    startHeartbeat: () => {},
    stopHeartbeat: () => {},
    snapshot: () => ({ instanceId: 'single', self: 0, others: 0, liveInstances: [], evictor: null }),
  }
}
