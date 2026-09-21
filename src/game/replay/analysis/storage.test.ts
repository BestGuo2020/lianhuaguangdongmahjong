import { afterEach, describe, expect, it } from 'vitest'
import { createAnalysisMemoryDriver, type AnalysisStoreDriver } from './idb'
import { createAnalysisStorage, type AnalysisStorage } from './storage'
import { createBudgetLease } from './leases'
import type { AnalysisBlockPart } from './codec'

// 分析区存储的验收点（方案 §9.2／§9.3／§9.4／§9.5）：
// 独立失败域、字节账本与预算淘汰顺序、不可变追加、raw 降级门槛、生命周期绑定场次、配置引用计数、
// 以及"后台写入不刷新最近查看时间"。

const originalCompression = (globalThis as { CompressionStream?: unknown }).CompressionStream
const originalDecompression = (globalThis as { DecompressionStream?: unknown }).DecompressionStream

afterEach(() => {
  ;(globalThis as { CompressionStream?: unknown }).CompressionStream = originalCompression
  ;(globalThis as { DecompressionStream?: unknown }).DecompressionStream = originalDecompression
})

function withoutCompression() {
  ;(globalThis as { CompressionStream?: unknown }).CompressionStream = undefined
  ;(globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined
}

/** 造一批够分块的记录（默认目标 48KiB ⇒ 这条会跨多块）。 */
function parts(count: number, tag = 'decision'): AnalysisBlockPart[] {
  return Array.from({ length: count }, (_, index) => ({
    tag,
    value: {
      id: `d${index}`, seat: index % 4, windowKind: 'draw-turn',
      candidates: Array.from({ length: 10 }, (_, k) => ({ legalActionId: `a${k}`, action: { id: `a${k}`, kind: 'discard', tile: 'm5', handIndex: k } })),
    },
  }))
}

/** 包一层可注入故障的驱动：用于验证失败隔离。 */
function faulty(driver: AnalysisStoreDriver, failOn: (label: string) => boolean, labels: { current: string }): AnalysisStoreDriver {
  const wrap = <T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    labels.current = label
    if (failOn(label)) return Promise.reject(new Error(`injected failure: ${label}`))
    return run()
  }
  return {
    putBlock: (record) => wrap('putBlock', () => driver.putBlock(record), false),
    listBlockMetas: (matchId) => wrap('listBlockMetas', () => driver.listBlockMetas(matchId), []),
    getBlock: (matchId, sequence) => wrap('getBlock', () => driver.getBlock(matchId, sequence), null),
    deleteMatchData: (matchId) => wrap('deleteMatchData', () => driver.deleteMatchData(matchId), undefined),
    listMatchMetas: () => wrap('listMatchMetas', () => driver.listMatchMetas(), []),
    getMatchMeta: (matchId) => wrap('getMatchMeta', () => driver.getMatchMeta(matchId), null),
    putMatchMeta: (meta) => wrap('putMatchMeta', () => driver.putMatchMeta(meta), undefined),
    getConfig: (id) => wrap('getConfig', () => driver.getConfig(id), null),
    putConfig: (record) => wrap('putConfig', () => driver.putConfig(record), undefined),
    listConfigs: () => wrap('listConfigs', () => driver.listConfigs(), []),
    deleteConfig: (id) => wrap('deleteConfig', () => driver.deleteConfig(id), undefined),
    clear: () => wrap('clear', () => driver.clear(), undefined),
    close: () => driver.close(),
  }
}

function makeStorage(options: Parameters<typeof createAnalysisStorage>[0] = {}): AnalysisStorage {
  return createAnalysisStorage({ driver: createAnalysisMemoryDriver(), ...options })
}

/**
 * 模拟两个标签页：共享同一个存储驱动（同源同一分区）与同一份 localStorage 替身。
 * §9.4 明确要求"不能只测单页或两个独立浏览器"、"不能只靠内存锁或各页自己的计数"。
 */
function twoTabs(budgetBytes: number) {
  const driver = createAnalysisMemoryDriver()
  const store = { value: null as string | null }
  const clock = { at: 1_000 }
  const leaseFor = (id: string) => createBudgetLease({
    load: () => store.value,
    save: (value) => { store.value = value },
    instanceId: id,
    now: () => clock.at,
    ttlMs: 30_000,
    // 心跳用可控定时器：测试里不需要真的跑定时器
    setTimer: () => 'timer',
    clearTimer: () => {},
  })
  const tab = (id: string) => createAnalysisStorage({ driver, maxBytes: budgetBytes, lease: leaseFor(id) })
  return { a: tab('tab-a'), b: tab('tab-b'), leaseFor, clock }
}

describe('分析区存储', () => {
  it('追加后可按序读回，账本记录条数与落库字节', async () => {
    const storage = makeStorage()
    const result = await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(120))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocks).toBeGreaterThanOrEqual(1)
    expect(result.storedBytes).toBeGreaterThan(0)

    const read = await storage.read('m1')
    expect(read.parts).toHaveLength(120)
    expect(read.complete).toBe(true)
    expect(read.meta?.parts).toBe(120)
    expect(read.meta?.blockCount).toBe(result.blocks)
    expect(read.meta?.storedBytes).toBe(result.storedBytes)
    expect((read.parts[0].value as { id: string }).id).toBe('d0')
    expect((read.parts[119].value as { id: string }).id).toBe('d119')

    const usage = await storage.usage()
    expect(usage.bytes).toBe(result.storedBytes)
    expect(usage.matches).toBe(1)
  })

  it('块不可变：同序号不会被覆盖，序号随写入递增', async () => {
    const storage = makeStorage()
    await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(1))
    const first = await storage.read('m1')
    expect(first.meta?.blockCount).toBe(1)

    const driver = createAnalysisMemoryDriver()
    const direct = createAnalysisStorage({ driver })
    await direct.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(1))
    const second = await driver.putBlock({
      id: 'm1#1', matchId: 'm1', sequence: 1, codec: 'raw', rawBytes: 1, storedBytes: 1,
      checksum: 'fnv1a-00000000', parts: 1, payload: new Uint8Array([0]),
    })
    expect(second).toBe(false)   // 已存在 ⇒ 拒绝覆盖
    const after = await direct.read('m1')
    expect(after.parts).toHaveLength(1)
  })

  // §9.4 的跨标签页要求：两页共享同一份字节预算，在途预留要互相看得见；
  // 一页关掉（不再心跳）后留下的预留必须能被回收，否则另一页会永远少一块可用空间。
  // §9.4：启动时读一次 estimate()（每次加载只问一次，不跟着写入频率走）
  it('创建存储时读一次浏览器容量估算，且读数只用于下调预算', async () => {
    let calls = 0
    const storage = createAnalysisStorage({
      driver: createAnalysisMemoryDriver(),
      maxBytes: 100 * 1024 * 1024,
      storageManager: { estimate: async () => { calls += 1; return { usage: 95 * 1024 * 1024, quota: 100 * 1024 * 1024 } } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls, '启动时读一次').toBe(1)
    expect(storage.budget(), '压力高时下调预算').toBeLessThan(100 * 1024 * 1024)
    expect(storage.budget()).toBeGreaterThan(0)
  })

  it('跨标签页预算：一页在途预留让另一页让路；关闭一页后遗留预留被回收', async () => {    const { b, leaseFor, clock } = twoTabs(1_000)
    // 模拟"标签页 A 正在写一大块"：它的在途预留必须被 B 看见
    const other = leaseFor('tab-a')
    other.reserve(900)
    const blocked = await b.write('m-b', { rulesetId: 'lotus-blood-flow' }, parts(20))
    // B 自己的账本是空的，但 A 占着 900/1000 ⇒ 本块放不下：暂停并留痕（detail 里带上在途数字）
    expect(blocked).toMatchObject({ ok: false, reason: 'paused' })
    expect(blocked.detail).toContain('inflight=900')

    // A 关掉且不再心跳：超过 ttl 后它的预留被回收，B 立刻写得进去（清空后另开一场）
    clock.at += 31_000
    const allowed = await b.write('m-b2', { rulesetId: 'lotus-blood-flow' }, parts(20))
    expect(allowed.ok, '回收遗留预留后应能写入').toBe(true)
  })

  // §9.3：单条超大记录（模型超长回答）要走片段化 —— 分块保持有界，读回来原文逐字一致
  it('超大单条记录：分块保持有界，读回后原文逐字一致（§9.3）', async () => {
    const storage = makeStorage()
    const answer = '字'.repeat(80_000)
    const result = await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, [
      { tag: 'config', value: { id: 'config/m1/1' } },
      { tag: 'llmAttempt', value: { id: 'attempt/1', answer } },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 单块原始字节不应等于"整条记录塞进一块"（目标 48KiB ⇒ 必然多块）
    expect(result.blocks).toBeGreaterThan(1)
    const metas = await storage.read('m1')
    expect(metas.complete).toBe(true)
    expect(metas.parts.map(part => part.tag)).toEqual(['config', 'llmAttempt'])
    expect((metas.parts[1].value as { answer: string }).answer).toBe(answer)
    expect((metas.parts[1].value as { answer: string }).answer.length).toBe(80_000)
  })

  // §9.3：片段缺片时读取侧必须把这一场标成不完整，而不是给半份回答
  it('片段缺片：读取侧标为不完整（fragment-incomplete），不返回半份数据', async () => {
    const storage = makeStorage()
    // 直接写入"只有第 0 片、却声明共 9 片"的片段（模拟落库中断后的库内容）
    await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, [
      { tag: 'fragment', value: { id: 'g1', index: 0, total: 9, tag: 'llmAttempt', text: '{"answer":"半份' } },
    ])
    const read = await storage.read('m1')
    expect(read.complete, '缺片的场次不能算完整').toBe(false)
    expect(read.reason).toBe('fragment-incomplete')
    expect(read.parts, '不得返回半份数据').toEqual([])
  })

  // §9.4「清理应跨实例协调」：另一页正在淘汰时，本页不做淘汰（让调用方按预算不足如实降级），
  // 而不是两页同时删、把彼此的账本与配置引用搞乱。
  it('跨标签页淘汰协调：令牌被别的页持有时本页不淘汰，释放后又能淘汰', async () => {
    const { b, leaseFor } = twoTabs(10_000_000)
    await b.write('older', { rulesetId: 'lotus-blood-flow' }, parts(30))
    const before = (await b.read('older')).meta?.blockCount ?? 0
    expect(before).toBeGreaterThan(0)

    const other = leaseFor('tab-a')
    expect(other.tryAcquireEviction()).toBe(true)
    const skipped = await b.evictToBudget({ budgetBytes: 0 })
    expect(skipped.removed, '令牌在别人手里时不淘汰').toEqual([])
    expect(skipped.freedBytes).toBe(0)
    expect(await b.status('older'), '另一页的数据没被本页删掉').toBe('complete')

    other.releaseEviction()
    const evicted = await b.evictToBudget({ budgetBytes: 0 })
    expect(evicted.removed, '令牌回到自己手里后可以淘汰').toEqual(['older'])
    expect(await b.status('older')).toBe('disabled')
  })

  it('压缩不可用且超出 raw 预算：不落库、暂停该场并留下缺失原因', async () => {    withoutCompression()
    const storage = makeStorage({ rawBudgetBytes: 10 })
    const result = await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(10))
    // 失败原因统一为 'paused'，而 detail 写明**最初**是哪一步暂停的（否则线上只能看到笼统的 budget）
    expect(result).toMatchObject({ ok: false, reason: 'paused', storedBytes: 0, blocks: 0, paused: true })
    expect(result.detail).toContain('raw-block-over-budget')
    const read = await storage.read('m1')
    expect(read.parts).toHaveLength(0)
    expect(read.meta?.status).toBe('partial')
    expect(read.meta?.gaps.map((gap) => gap.reason)).toContain('raw-block-over-budget')
    // 暂停后不再尝试写入，而不是反复失败（§9.3、§9.4）
    expect(await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(1))).toMatchObject({ ok: false, paused: true })
  })

  it('字节预算：先淘汰最久未查看的分析区，受保护的当前场不动；仍不够则暂停并留痕', async () => {
    const storage = makeStorage({ maxBytes: 1_000_000 })
    await storage.write('old', { rulesetId: 'lotus-blood-flow' }, parts(60))
    await storage.write('recent', { rulesetId: 'lotus-blood-flow' }, parts(60))
    const oldBytes = (await storage.read('old')).meta?.storedBytes ?? 0
    const recentBytes = (await storage.read('recent')).meta?.storedBytes ?? 0
    await storage.markViewed('recent')

    // 预算收紧到只装得下其中一场：最久未查看的 old 应先被淘汰
    storage.setBudget(Math.max(oldBytes, recentBytes) + 10)
    const evicted = await storage.evictToBudget()
    expect(evicted.removed).toEqual(['old'])
    expect(await storage.status('old')).toBe('disabled')
    expect(await storage.status('recent')).toBe('complete')

    // 当前正在写入的场次受保护：预算不足时暂停它自己，而不是删掉它
    storage.setBudget(10)
    const paused = await storage.write('recent', { rulesetId: 'lotus-blood-flow' }, parts(40))
    expect(paused).toMatchObject({ ok: false, reason: 'paused', paused: true })
    // detail 必须带上当时的账本数字：只报"预算不足"无法区分账本异常与真的满了
    expect(paused.detail).toContain('budget-exceeded')
    expect(paused.detail).toContain('budget=')
    const meta = (await storage.read('recent')).meta
    expect(meta?.status).toBe('partial')
    expect(meta?.gaps.map((gap) => gap.reason)).toContain('budget-exceeded')
  })

  it('生命周期绑定场次：展示回放已不在的场，其分析区同步清理', async () => {
    const storage = makeStorage()
    await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(5))
    await storage.write('m2', { rulesetId: 'lotus-blood-flow' }, parts(5))
    await storage.retainConfig('m2', { id: 'cfg-1', value: { rulesVersion: 'v1' } })

    const removed = await storage.reconcileLifecycle(['m1'])
    expect(removed).toEqual(['m2'])
    expect(await storage.status('m2')).toBe('disabled')
    expect(await storage.status('m1')).toBe('complete')
    expect(await storage.readConfigs('m2')).toEqual([])
  })

  it('单独删除分析区：留「已删除」墓碑、释放字节与配置引用，展示回放不受影响', async () => {
    const storage = makeStorage()
    await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(30))
    await storage.retainConfig('m1', { id: 'cfg-1', value: { rulesVersion: 'v1' } })
    const before = await storage.usage()
    expect(before.bytes).toBeGreaterThan(0)

    await storage.removeAnalysis('m1')
    expect(await storage.status('m1')).toBe('deleted')
    const after = await storage.usage()
    expect(after.bytes).toBe(0)
    expect(after.matches).toBe(0)
    expect((await storage.read('m1')).parts).toHaveLength(0)
    // 字节账本不再计入已删除场
    const write = await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(2))
    expect(write.ok).toBe(true)
  })

  // 回归：写入遇到墓碑时必须复活，否则导入/重新录制回去的记录永远显示「已删除」，
  // 且 noteGap 会继续把状态压回 deleted —— 四态就再也回不去。
  it('已删除的场次再写入 ⇒ 状态复活为完整，配置引用不漏（§9.2、§9.4）', async () => {
    const storage = makeStorage()
    await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(5))
    await storage.removeAnalysis('m1')
    expect(await storage.status('m1')).toBe('deleted')

    // 导入流程的真实顺序：先登记配置引用，再写回记录
    await storage.retainConfig('m1', { id: 'cfg-imported', value: { rulesVersion: 'v1' } })
    const write = await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(4))
    expect(write.ok).toBe(true)
    expect(await storage.status('m1'), '写入后不应继续是「已删除」').toBe('complete')
    const read = await storage.read('m1')
    expect(read.parts.length).toBeGreaterThan(0)
    expect(await storage.readConfigs('m1')).toEqual([{ rulesVersion: 'v1' }])

    // 复活后不完整仍按 partial 记录
    await storage.noteGap('m1', { scope: 'import', reason: 'package-marked-partial' })
    expect(await storage.status('m1')).toBe('partial')

    // 再删除：新登记的配置引用要被释放（否则引用计数泄漏）
    await storage.removeAnalysis('m1')
    expect(await storage.status('m1')).toBe('deleted')
    expect(await storage.readConfigs('m1')).toEqual([])
  })

  it('配置引用计数：两场共享同一版本配置，删一场不影响另一场，零引用才回收', async () => {
    const driver = createAnalysisMemoryDriver()
    const storage = createAnalysisStorage({ driver })
    const config = { id: 'cfg-shared', value: { rulesVersion: 'v1', aiStrategy: 'source-v2' } }
    await storage.write('A', { rulesetId: 'lotus-blood-flow' }, parts(2))
    await storage.write('B', { rulesetId: 'lotus-blood-flow' }, parts(2))
    await storage.retainConfig('A', config)
    await storage.retainConfig('B', config)
    expect((await driver.listConfigs())[0].owners.sort()).toEqual(['A', 'B'])

    // 删 A → B 仍能完整读到配置
    await storage.removeAnalysis('A')
    expect(await storage.readConfigs('B')).toEqual([config.value])
    expect((await driver.listConfigs())[0].owners).toEqual(['B'])

    // 删 B → 零引用，配置回收（不留悬空引用）
    await storage.removeAnalysis('B')
    expect(await driver.listConfigs()).toEqual([])
    expect(await storage.readConfigs('B')).toEqual([])

    // 重复删除不产生负计数
    await storage.removeAnalysis('B')
    expect(await driver.listConfigs()).toEqual([])
  })

  it('后台写入不刷新最近查看时间；markViewed 才会刷新', async () => {
    let clock = 1_000
    const storage = makeStorage({ now: () => clock })
    await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(2))
    const created = (await storage.read('m1')).meta!
    clock += 5_000
    await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(2))
    expect((await storage.read('m1')).meta?.lastViewedAt).toBe(created.lastViewedAt)
    await storage.markViewed('m1')
    expect((await storage.read('m1')).meta?.lastViewedAt).toBe(clock)
  })

  it('失败隔离：驱动故障只停用分析侧，不抛错；另一实例（展示回放）不受影响', async () => {
    const errors: string[] = []
    const labels = { current: '' }
    const broken = createAnalysisStorage({
      driver: faulty(createAnalysisMemoryDriver(), (label) => label === 'putBlock', labels),
      onError: (detail) => errors.push(detail),
    })
    const replaySide = makeStorage()

    const result = await broken.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(3))
    expect(result).toMatchObject({ ok: false })
    expect(broken.available()).toBe(false)
    expect(errors.join(' | ')).toContain('追加分析块 失败')
    // 失败后所有调用安全空转，不抛错
    await expect(broken.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(1))).resolves.toMatchObject({ ok: false })
    await expect(broken.usage()).resolves.toEqual({ bytes: 0, matches: 0 })
    await expect(broken.reconcileLifecycle([])).resolves.toEqual([])
    // 展示回放侧（独立实例）仍然正常工作
    await expect(replaySide.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(3))).resolves.toMatchObject({ ok: true })
    expect(replaySide.available()).toBe(true)
  })

  it('noteGap 把缺失范围与原因写进元数据（不完整也必须留痕）', async () => {
    const storage = makeStorage()
    await storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(2))
    await storage.noteGap('m1', { scope: 'round', from: 3, to: 4, reason: 'queue-overflow' })
    const meta = (await storage.read('m1')).meta!
    expect(meta.status).toBe('partial')
    expect(meta.gaps).toEqual([{ scope: 'round', from: 3, to: 4, reason: 'queue-overflow' }])
    expect((await storage.read('m1')).complete).toBe(false)
  })

  it('没有驱动的环境（无 IDB）所有方法安全空转', async () => {
    const storage = createAnalysisStorage({ driver: null })
    expect(storage.available()).toBe(false)
    await expect(storage.write('m1', { rulesetId: 'lotus-blood-flow' }, parts(1))).resolves.toMatchObject({ ok: false, reason: 'unavailable' })
    await expect(storage.read('m1')).resolves.toMatchObject({ parts: [], meta: null })
    await expect(storage.status('m1')).resolves.toBe('disabled')
    await expect(storage.usage()).resolves.toEqual({ bytes: 0, matches: 0 })
  })
})
