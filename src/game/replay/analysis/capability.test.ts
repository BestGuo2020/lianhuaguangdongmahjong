import { describe, expect, it, vi } from 'vitest'
import { createStorageCapability, persistenceLabel, type StorageManagerLike } from './capability'

// §9.4／§10.11 的存储能力探测验收点：
// 1. 首次启用时查 persisted()，未持久化就申请一次 persist()，结果（获准/拒绝/不支持/抛错）如实记录；
// 2. **不反复申请**（跨会话记住），也不因为探测失败打断任何流程；
// 3. estimate() 只在压力高时**下调**预算建议，绝不"上调"；
// 4. 接口缺失、抛异常都安全降级。

function probe(manager: StorageManagerLike | null, overrides: Parameters<typeof createStorageCapability>[0] = {}) {
  const saved: string[] = []
  const capability = createStorageCapability({
    storage: manager,
    load: () => saved.at(-1) ?? null,
    save: (value) => saved.push(value),
    now: () => 1_700_000_000_000,
    ...overrides,
  })
  return { capability, saved }
}

describe('浏览器存储能力探测（§9.4）', () => {
  it('已持久化：只读 persisted()，不申请 persist()', async () => {
    const persist = vi.fn(async () => true)
    const { capability } = probe({ persisted: async () => true, persist })
    const snapshot = await capability.ensurePersistence()
    expect(snapshot.persistence).toBe('persisted')
    expect(persist, '已持久化就不该再申请').not.toHaveBeenCalled()
  })

  it('未持久化：申请一次 persist()，获准记 persisted', async () => {
    const persist = vi.fn(async () => true)
    const { capability } = probe({ persisted: async () => false, persist })
    expect((await capability.ensurePersistence()).persistence).toBe('persisted')
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('申请被拒：记 denied，且**再调用也不重复申请**（§9.4：不在每次开局反复申请）', async () => {
    const persist = vi.fn(async () => false)
    const { capability } = probe({ persisted: async () => false, persist })
    expect((await capability.ensurePersistence()).persistence).toBe('denied')
    await capability.ensurePersistence()
    await capability.ensurePersistence()
    expect(persist, '只在首次明确操作里申请一次').toHaveBeenCalledTimes(1)
    expect(capability.snapshot().requestedAt).toBe(1_700_000_000_000)
  })

  it('跨会话记住「已经问过」：重开后不再申请', async () => {
    const first = probe({ persisted: async () => false, persist: async () => false })
    await first.capability.ensurePersistence()
    const second = probe({ persisted: async () => false, persist: vi.fn(async () => true) })
    // 用第一次留下的状态构造第二个实例
    const restored = createStorageCapability({
      storage: { persisted: async () => false, persist: vi.fn(async () => true) },
      load: () => first.saved.at(-1) ?? null,
      save: () => {},
      now: () => 2,
    })
    expect((await restored.ensurePersistence()).persistence).toBe('denied')
    void second
  })

  it('接口抛错：记 unavailable 并保留原因，不抛给调用方', async () => {
    const { capability } = probe({ persisted: async () => false, persist: async () => { throw new Error('SecurityError') } })
    const snapshot = await capability.ensurePersistence()
    expect(snapshot.persistence).toBe('unavailable')
    expect(snapshot.lastError).toContain('SecurityError')
  })

  it('没有 navigator.storage：记 unsupported，其余照常', async () => {
    const { capability } = probe(null)
    expect((await capability.ensurePersistence()).persistence).toBe('unsupported')
    expect((await capability.refreshEstimate()).estimate).toBeNull()
  })

  it('estimate()：正常读数会记录下来（同源估算）', async () => {
    const { capability } = probe({ estimate: async () => ({ usage: 30 * 1024 * 1024, quota: 200 * 1024 * 1024 }) })
    const snapshot = await capability.refreshEstimate()
    expect(snapshot.estimate).toEqual({ usage: 30 * 1024 * 1024, quota: 200 * 1024 * 1024, at: 1_700_000_000_000 })
  })

  it('压力高：给出下调后的预算建议（留余量、有下限），压力低则不动预算', async () => {
    const onBudgetPressure = vi.fn()
    const tight = probe({ estimate: async () => ({ usage: 190 * 1024 * 1024, quota: 200 * 1024 * 1024 }) }, { onBudgetPressure })
    await tight.capability.refreshEstimate()
    expect(onBudgetPressure).toHaveBeenCalledTimes(1)
    const info = onBudgetPressure.mock.calls[0][0] as { usage: number; quota: number; suggestedBytes: number }
    expect(info.suggestedBytes).toBeLessThan(info.quota - info.usage)
    expect(info.suggestedBytes).toBeGreaterThan(0)

    const loose = probe({ estimate: async () => ({ usage: 1 * 1024 * 1024, quota: 200 * 1024 * 1024 }) }, { onBudgetPressure: vi.fn() })
    await loose.capability.refreshEstimate()
    expect(loose.capability.snapshot().estimate?.usage).toBe(1 * 1024 * 1024)
  })

  it('quota 为 0（接口给了空读数）：不据此下调预算，也不崩', async () => {
    const onBudgetPressure = vi.fn()
    const { capability } = probe({ estimate: async () => ({}) }, { onBudgetPressure })
    await capability.refreshEstimate()
    expect(onBudgetPressure).not.toHaveBeenCalled()
    expect(capability.snapshot().estimate).toEqual({ usage: 0, quota: 0, at: 1_700_000_000_000 })
  })

  it('文案不夸大：持久化也不等于"一定不会丢"', () => {
    expect(persistenceLabel('persisted')).toContain('仍可能')
    expect(persistenceLabel('denied')).toContain('可能被浏览器回收')
    expect(persistenceLabel('unsupported')).toContain('不支持')
  })
})
