// 浏览器存储能力探测（方案 §9.4、§10.11）。
//
// 设计要的三件事，这里逐条落实：
// 1. **首次启用分析录制时**检查 `persisted()`；未持久化就在这次明确操作里尝试 `persist()`，
//    并把「获准／拒绝／不支持」记下来 —— **不在每次开局反复申请**（用持久化状态记住已经问过）。
// 2. **启动、批量导入／清理后及有节制的定期检查**调用 `estimate()`；它只用来判断同源存储压力，
//    不能按它的读数覆盖本应用的逐块账本（§9.4），所以这里只做"压力高就下调预算"的辅助动作。
// 3. 一切失败都不抛错：接口不存在、被拒绝、抛异常都如实记进快照，调用方照常继续（§9.5 的失败域隔离）。
//
// 说明：`persist()` 只承诺"尽量不回收"，既不是空间预留也不是永不丢失（WHATWG Storage Standard）。

export type StoragePersistenceState =
  /** 已持久化（`persisted()` 为真，或本次 `persist()` 获准）。 */
  | 'persisted'
  /** 未持久化且没申请过（或接口存在但还没问）。 */
  | 'best-effort'
  /** 申请过但被拒绝。 */
  | 'denied'
  /** 环境不支持 `navigator.storage`。 */
  | 'unsupported'
  /** 接口存在但调用抛错（隐私模式、权限策略等）。 */
  | 'unavailable'

export interface StorageEstimateReading {
  usage: number
  quota: number
  at: number
}

export interface StorageCapabilitySnapshot {
  persistence: StoragePersistenceState
  /** 最近一次 `estimate()` 读数（同源估算，**不是**本应用账本）。 */
  estimate: StorageEstimateReading | null
  /** 是否已经申请过持久化（跨会话记住，避免反复打扰用户）。 */
  requestedAt: number | null
  /** 最近一次探测失败的原因（人读用）。 */
  lastError: string | null
}

/** `navigator.storage` 的最小面（便于注入与单测）。 */
export interface StorageManagerLike {
  persisted?: () => Promise<boolean>
  persist?: () => Promise<boolean>
  estimate?: () => Promise<{ usage?: number; quota?: number }>
}

export interface StorageCapabilityOptions {
  storage?: StorageManagerLike | null
  /** 持久化状态的读写（默认 localStorage；不可用时退化为内存）。 */
  load?: () => string | null
  save?: (value: string) => void
  now?: () => number
  /** 压力阈值（usage/quota 超过它即认为紧张，默认 0.8）。 */
  pressureRatio?: number
  /**
   * 压力回调：调用方据此**下调**字节预算（§9.4「浏览器可用容量信号只能辅助下调预算」）。
   * 不做任何"上调"——估算是估算，不能拿来扩预算。
   */
  onBudgetPressure?: (info: { usage: number; quota: number; suggestedBytes: number }) => void
  /** 下调预算时预留的临时写入余量（默认 16MB）。 */
  reserveBytes?: number
}

export interface StorageCapability {
  snapshot(): StorageCapabilitySnapshot
  /** 首次启用分析录制时调用：查 persisted，必要时申请一次 persist（只申请一次）。 */
  ensurePersistence(): Promise<StorageCapabilitySnapshot>
  /** 启动／批量导入清理后／定期检查：读 estimate，必要时下调预算。 */
  refreshEstimate(): Promise<StorageCapabilitySnapshot>
}

const PERSIST_KEY = 'lgm_analysis_storage_state'

function defaultLoad(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(PERSIST_KEY)
  } catch {
    return null
  }
}

function defaultSave(value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PERSIST_KEY, value)
  } catch {
    /* 隐私模式下写不进去：不影响分析录制本身 */
  }
}

function defaultStorage(): StorageManagerLike | null {
  const manager = (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator?.storage
  return manager ?? null
}

export function createStorageCapability(options: StorageCapabilityOptions = {}): StorageCapability {
  const manager = options.storage === undefined ? defaultStorage() : options.storage
  const now = options.now ?? (() => Date.now())
  const load = options.load ?? defaultLoad
  const save = options.save ?? defaultSave
  const pressureRatio = options.pressureRatio ?? 0.8
  const reserveBytes = options.reserveBytes ?? 16 * 1024 * 1024

  let persistence: StoragePersistenceState = manager ? 'best-effort' : 'unsupported'
  let estimate: StorageEstimateReading | null = null
  let requestedAt: number | null = null
  let lastError: string | null = null

  // 恢复跨会话状态：已经问过 persist 就不再问（§9.4：不在每次开局反复申请）
  try {
    const raw = load()
    if (raw) {
      const parsed = JSON.parse(raw) as { persistence?: StoragePersistenceState; requestedAt?: number | null; estimate?: StorageEstimateReading | null }
      if (parsed.persistence && parsed.persistence !== 'unsupported') persistence = parsed.persistence
      if (typeof parsed.requestedAt === 'number') requestedAt = parsed.requestedAt
      if (parsed.estimate && typeof parsed.estimate.usage === 'number' && typeof parsed.estimate.quota === 'number') estimate = parsed.estimate
    }
  } catch {
    /* 状态损坏就当没有：探测会重新得出结果 */
  }

  const snapshot = (): StorageCapabilitySnapshot => ({ persistence, estimate, requestedAt, lastError })
  const persistState = () => {
    try {
      save(JSON.stringify({ persistence, requestedAt, estimate }))
    } catch {
      /* 记不住就算了，不影响录制 */
    }
  }

  async function ensurePersistence(): Promise<StorageCapabilitySnapshot> {
    if (!manager) {
      persistence = 'unsupported'
      return snapshot()
    }
    try {
      if (manager.persisted && await manager.persisted()) {
        persistence = 'persisted'
        persistState()
        return snapshot()
      }
      // 已经申请过（被拒）就不再申请：避免每次开局都弹权限
      if (requestedAt !== null) {
        if (persistence !== 'denied') persistence = 'best-effort'
        return snapshot()
      }
      if (!manager.persist) {
        persistence = 'best-effort'
        return snapshot()
      }
      requestedAt = now()
      const granted = await manager.persist()
      persistence = granted ? 'persisted' : 'denied'
      persistState()
      return snapshot()
    } catch (error) {
      // 权限策略/隐私模式下 persist() 会抛：如实记为不可用，不打断对局
      lastError = error instanceof Error ? error.message : String(error)
      persistence = 'unavailable'
      requestedAt = now()
      persistState()
      return snapshot()
    }
  }

  async function refreshEstimate(): Promise<StorageCapabilitySnapshot> {
    if (!manager?.estimate) return snapshot()
    try {
      const reading = await manager.estimate()
      const usage = Math.max(0, Number(reading?.usage ?? 0))
      const quota = Math.max(0, Number(reading?.quota ?? 0))
      estimate = { usage, quota, at: now() }
      persistState()
      // 压力只用于**下调**预算：留出临时写入余量，且不低于一个可用的最小值
      if (quota > 0 && usage / quota >= pressureRatio) {
        const suggestedBytes = Math.max(1024 * 1024, quota - usage - reserveBytes)
        options.onBudgetPressure?.({ usage, quota, suggestedBytes })
      }
      return snapshot()
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      return snapshot()
    }
  }

  return { snapshot, ensurePersistence, refreshEstimate }
}

/** 人读文案：列表/诊断可以直接展示（不假装知道浏览器一定会保留数据）。 */
export function persistenceLabel(state: StoragePersistenceState): string {
  if (state === 'persisted') return '已持久化（浏览器仍可能在极端情况下回收）'
  if (state === 'denied') return '未持久化（申请被拒绝，可能被浏览器回收）'
  if (state === 'best-effort') return '未持久化（未申请）'
  if (state === 'unavailable') return '持久化接口不可用'
  return '当前环境不支持存储持久化接口'
}
