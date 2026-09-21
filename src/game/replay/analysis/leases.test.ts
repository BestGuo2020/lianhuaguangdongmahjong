import { describe, expect, it } from 'vitest'
import { createBudgetLease, createNoopBudgetLease } from './leases'

// §9.4 的跨标签页预算预留验收点（设计明确要求"不能只靠内存锁或各页自己的计数"）：
// 1. 一页的在途预留，另一页看得见（同源共享）；
// 2. 一页关掉（不再心跳）后，它的预留会在 ttl 之后被回收 —— 这就是"关闭一页后恢复遗留预留"；
// 3. 本页释放后别人立刻看不见；重复释放不出错、不产生负数；
// 4. 心跳能保活（不会把自己的预留回收掉），停止心跳后会被别人回收。

/** 共享的 localStorage 替身：两个实例（两个"标签页"）用同一份。 */
function sharedStore() {
  let value: string | null = null
  return {
    load: () => value,
    save: (next: string) => { value = next },
    raw: () => value,
  }
}

function leaseOn(store: ReturnType<typeof sharedStore>, id: string, now: () => number, ttlMs = 30_000) {
  return createBudgetLease({
    load: store.load, save: store.save, instanceId: id, now, ttlMs,
    // 心跳用可控定时器：测试里手动触发，避免依赖真实时间
    setTimer: () => 'timer',
    clearTimer: () => {},
  })
}

describe('跨标签页预算预留（§9.4）', () => {
  it('一页的在途预留另一页看得见', () => {
    const store = sharedStore()
    const clock = { at: 1_000 }
    const a = leaseOn(store, 'tab-a', () => clock.at)
    const b = leaseOn(store, 'tab-b', () => clock.at)
    a.reserve(64 * 1024)
    expect(b.othersReserved()).toBe(64 * 1024)
    expect(a.snapshot().self).toBe(64 * 1024)
    expect(b.snapshot().self).toBe(0)
  })

  it('同页重复预留是覆盖而不是累加（同一时刻只有一份在途）', () => {
    const store = sharedStore()
    const a = leaseOn(store, 'tab-a', () => 1_000)
    a.reserve(1_000)
    a.reserve(2_000)
    expect(a.snapshot().self).toBe(2_000)
  })

  it('关闭一页（不再心跳）后，遗留预留被回收（ttl 之后）', () => {
    const store = sharedStore()
    const clock = { at: 1_000 }
    const closed = leaseOn(store, 'tab-closed', () => clock.at)
    const alive = leaseOn(store, 'tab-alive', () => clock.at)
    closed.reserve(10 * 1024 * 1024)
    expect(alive.othersReserved()).toBe(10 * 1024 * 1024)

    clock.at += 31_000
    expect(alive.othersReserved(), '超过 ttl 的预留应视为那一页已关闭').toBe(0)
    // 回收要落回共享状态：新实例也看不到陈旧预留
    const fresh = leaseOn(store, 'tab-new', () => clock.at)
    expect(fresh.othersReserved()).toBe(0)
  })

  it('ttl 以内不会误回收（那一页只是这一会儿没写东西）', () => {
    const store = sharedStore()
    const clock = { at: 1_000 }
    const a = leaseOn(store, 'tab-a', () => clock.at)
    const b = leaseOn(store, 'tab-b', () => clock.at)
    a.reserve(4_096)
    clock.at += 5_000
    expect(b.othersReserved()).toBe(4_096)
  })

  it('释放后别人立刻看不见；重复释放安全、不出负数', () => {
    const store = sharedStore()
    const a = leaseOn(store, 'tab-a', () => 1_000)
    const b = leaseOn(store, 'tab-b', () => 1_000)
    a.reserve(8_192)
    a.release()
    a.release()
    expect(b.othersReserved()).toBe(0)
    expect(a.snapshot().self).toBe(0)
    expect(JSON.parse(store.raw() ?? '{}')).toEqual({})
  })

  it('坏数据不致崩：状态损坏时按"没有预留"处理', () => {
    let value = '{ 这不是 json'
    const broken = createBudgetLease({ load: () => value, save: (next) => { value = next }, instanceId: 'a', now: () => 1 })
    expect(broken.othersReserved()).toBe(0)
    broken.reserve(1_024)
    expect(broken.snapshot().self).toBe(1_024)
  })

  it('心跳保活：刷新时间戳后不会被回收（手动触发心跳回调）', () => {
    const store = sharedStore()
    const clock = { at: 1_000 }
    let beat: (() => void) | null = null
    const a = createBudgetLease({
      load: store.load, save: store.save, instanceId: 'tab-a', now: () => clock.at, ttlMs: 10_000,
      setTimer: (run) => { beat = run; return 'timer' }, clearTimer: () => {},
    })
    const b = leaseOn(store, 'tab-b', () => clock.at, 10_000)
    a.reserve(2_048)
    a.startHeartbeat()
    clock.at += 9_000
    beat?.()
    clock.at += 9_000
    expect(b.othersReserved(), '心跳之后仍算活着').toBe(2_048)
    a.stopHeartbeat()
    clock.at += 11_000
    expect(b.othersReserved(), '停止心跳后按 ttl 回收').toBe(0)
  })

  it('无共享存储时的空实现：没有别的实例，也不写任何状态', () => {
    const none = createNoopBudgetLease()
    none.reserve(1_000)
    expect(none.othersReserved()).toBe(0)
    expect(none.snapshot()).toEqual({ instanceId: 'single', self: 0, others: 0, liveInstances: [] })
  })
})
