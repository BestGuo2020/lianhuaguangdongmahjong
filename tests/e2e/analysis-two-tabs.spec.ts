import { expect, test } from '@playwright/test'

// §9.4／§10.10 的必测项：**同源两标签页**并发录制与清理。
//
// 设计原文：「同一浏览器配置文件、同一存储分区内的同源多标签页共享存储预算；不能只测单页或
// 两个独立浏览器」「测试两页同时录制／导入、关闭一页后恢复遗留预留、重复删除与额度竞争」。
// 这里在**同一个 browser context** 里开两个页面（同源 ⇒ 共享 localStorage 与 IndexedDB），
// 各自跑完一场血流并开分析录制，然后核对：
// 1. 两场都完整落库（没有因为并发而互相挤掉：预算是共享的，但记账与追加要各自正确）；
// 2. 逐块字节之和 == 场次元数据账本（跨页写入不会把账本写乱）；
// 3. A 页删掉 B 那场的分析后，B 页立刻看得到「已删除」，而 A 那场仍然完整；
// 4. 全程没有配额/暂停类失败（分析失败会出现在探针的 errors 里）。
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

interface ProbeStatus {
  ready: boolean
  error: string | null
  errors: string[]
  matchId: string
  rounds: Array<{ roundIndex: number; replay: { ok: boolean; reason: string | null; submitted: number; recorded: number } | null }>
}

const FIXTURE = '/tests/e2e/fixtures/analysis-probe.html'

async function waitReady(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const probe = (window as unknown as { __analysisProbe?: ProbeStatus }).__analysisProbe
    return Boolean(probe?.ready || probe?.error)
  }, undefined, { timeout: 240_000 })
  return page.evaluate(() => (window as unknown as { __analysisProbe: ProbeStatus }).__analysisProbe)
}

test('同源两标签页并发录制：账本一致、跨页可见、删一场不影响另一场（§9.4、§10.10）', async ({ context }) => {
  const pageA = await context.newPage()
  const pageB = await context.newPage()
  const errors: string[] = []
  pageA.on('pageerror', (error) => errors.push(`A: ${error.message}`))
  pageB.on('pageerror', (error) => errors.push(`B: ${error.message}`))

  // 两页**同时**开局录制（真正的并发，而不是先后跑）
  await Promise.all([pageA.goto(FIXTURE), pageB.goto(FIXTURE)])
  const [probeA, probeB] = await Promise.all([waitReady(pageA), waitReady(pageB)])

  for (const [label, probe] of [['A', probeA], ['B', probeB]] as const) {
    expect(probe.error, `${label} 页探针出错：${probe.error}`).toBeNull()
    expect(probe.errors, `${label} 页录制报错：${probe.errors.join(' | ')}`).toEqual([])
    expect(probe.matchId, `${label} 页应有场次 id`).toBeTruthy()
    expect(probe.rounds.length, `${label} 页东风场应有 4 局`).toBe(4)
    for (const round of probe.rounds) {
      expect(round.replay?.reason, `${label} 页第 ${round.roundIndex} 局应复现成功`).toBeNull()
      expect(round.replay?.submitted, `${label} 页第 ${round.roundIndex} 局应消费完记录`).toBe(round.replay?.recorded)
    }
  }
  expect(probeA.matchId).not.toBe(probeB.matchId)
  expect(errors).toEqual([])

  // 账本与分块：在 A 页读同一个库（两页共享），逐场核对"分块字节之和 == 元数据账本"
  const ledger = await pageA.evaluate(async () => {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open('lianhua-guangma-analysis')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    if (!db) return null
    const readAll = <T,>(store: string) => new Promise<T[]>((resolve) => {
      const tx = db.transaction(store, 'readonly')
      const request = tx.objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result as T[])
      request.onerror = () => resolve([])
    })
    const matches = await readAll<{ matchId: string; status: string; blockCount: number; storedBytes: number; parts: number }>('matches')
    const blocks = await readAll<{ matchId: string; sequence: number; storedBytes: number; parts: number }>('blocks')
    const configs = await readAll<{ id: string; owners: string[] }>('configs')
    db.close()
    return {
      matches: matches.map(match => ({ ...match })),
      blocks: blocks.map(block => ({ ...block })),
      configs: configs.map(config => ({ id: config.id, owners: [...config.owners] })),
    }
  })
  expect(ledger, '应能读到分析库').toBeTruthy()
  const matches = ledger!.matches.filter(match => [probeA.matchId, probeB.matchId].includes(match.matchId))
  expect(matches, '两页的场次都应在库里').toHaveLength(2)
  for (const match of matches) {
    expect(match.status, '并发录制不应把任何一场写成 partial').toBe('complete')
    const own = ledger!.blocks.filter(block => block.matchId === match.matchId)
    expect(own.length, '块数应与元数据一致').toBe(match.blockCount)
    expect(own.reduce((total, block) => total + block.storedBytes, 0), '逐块字节之和应等于账本').toBe(match.storedBytes)
    expect(own.reduce((total, block) => total + block.parts, 0), '记录条数也应一致').toBe(match.parts)
    // 序号连续（不可变追加的中断识别依据）
    expect(own.map(block => block.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: own.length }, (_, index) => index + 1))
  }
  // 配置引用按场次登记，两页各一份、互不覆盖
  for (const matchId of [probeA.matchId, probeB.matchId]) {
    expect(ledger!.configs.some(config => config.owners.includes(matchId)), `${matchId} 应有配置引用`).toBe(true)
  }

  // 跨页清理：A 页删掉 B 那场的分析 ⇒ B 页立刻看到「已删除」，A 那场不受影响
  const removed = await pageA.evaluate(async (matchId) => {
    const { createAnalysisStorage } = await import('/src/game/replay/analysis/storage.ts')
    const storage = createAnalysisStorage()
    await storage.removeAnalysis(matchId)
    const usage = await storage.usage()
    storage.close()
    return usage
  }, probeB.matchId)
  const seenByB = await pageB.evaluate(async (matchId) => {
    const { createAnalysisStorage } = await import('/src/game/replay/analysis/storage.ts')
    const storage = createAnalysisStorage()
    const status = await storage.status(matchId)
    const read = await storage.read(matchId)
    storage.close()
    return { status, parts: read.parts.length }
  }, probeB.matchId)
  const stillThere = await pageA.evaluate(async (matchId) => {
    const { createAnalysisStorage } = await import('/src/game/replay/analysis/storage.ts')
    const storage = createAnalysisStorage()
    const read = await storage.read(matchId)
    const configs = await storage.readConfigs(matchId)
    const usage = await storage.usage()
    storage.close()
    return { complete: read.complete, parts: read.parts.length, configs: configs.length, usage }
  }, probeA.matchId)
  expect(seenByB.status, '另一页删除后本页应立即看到「已删除」').toBe('deleted')
  expect(seenByB.parts).toBe(0)
  expect(stillThere.complete, '未被删除的那场必须仍然完整').toBe(true)
  expect(stillThere.parts).toBeGreaterThan(0)
  expect(stillThere.configs, '另一场的配置引用不受影响').toBeGreaterThan(0)
  expect(removed.matches, '删除一场后账本只剩一场').toBe(1)
  expect(stillThere.usage.bytes).toBeLessThanOrEqual(removed.bytes)
  console.log(`[two-tabs] A=${probeA.matchId.slice(0, 8)} B=${probeB.matchId.slice(0, 8)}；两队 4 局均复现成功；`
    + `删除 B 后账本 ${removed.bytes} 字节 / ${removed.matches} 场`)
})
