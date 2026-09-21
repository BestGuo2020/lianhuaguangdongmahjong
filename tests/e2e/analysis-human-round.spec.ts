import { expect, test } from '@playwright/test'

// §10.6 的人类座位端到端复现（**慢用例，默认跳过**）：
// 常规 e2e 用 autoplay 对局覆盖逐局复现（analysis-probe / replay.spec），人类座位只覆盖到
// "命令入列正确 + 记录与权威不一致时明确报错"（analysis-human.spec.ts）。
// 本用例不改造牌墙，老老实实打完东1局（人类每回合点牌、被问到鸣牌就过），
// 然后进第二局让第一局的复现数据随下一批记录刷进库，再把它喂回引擎重跑到同一结束状态。
//
// 为什么单列成慢用例：单局约 3~5 分钟（814 张牌墙的正常节奏），不适合放进每次提交都跑的套件。
// 运行方式：`$env:E2E_SLOW=1; npx playwright test tests/e2e/analysis-human-round.spec.ts`
test.setTimeout(900_000)

test('人类座位打完整局：该局能重跑到同一结束状态（慢用例，需 E2E_SLOW=1）', async ({ page }) => {
  test.skip(process.env.E2E_SLOW !== '1', '慢用例：单局约 3~5 分钟，设置 E2E_SLOW=1 才运行')
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/?bloodFlow=1')
  await page.getByRole('radio', { name: /单机对战/ }).click()
  await page.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  await page.getByRole('button', { name: /莲花麻将·血流/ }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await page.locator('.start-button').click()

  const enabledTiles = page.locator('.hand-tile-slot .mahjong-tile:not(.disabled)')
  const summary = page.getByRole('dialog', { name: /血流(本局结算|最终排名|公开流水)/ })
  /** 人类回合就点牌、被问到鸣牌就过（否则窗口要等 15s 倒计时）。 */
  const clickOnce = async () => {
    const pass = page.locator('.action-bar').getByRole('button', { name: '过', exact: true })
    if (await pass.count() && await pass.isVisible()) await pass.click({ timeout: 3_000 }).catch(() => {})
    else if (await enabledTiles.count()) await enabledTiles.last().click({ timeout: 5_000 }).catch(() => {})
  }
  /** 打到某个条件成立（无界：用于"打完这一局"）。 */
  const playUntil = async (stop: () => Promise<boolean>) => {
    while (!(await stop())) { await clickOnce(); await page.waitForTimeout(120) }
  }
  /** 有界地点一会儿牌（轮询之间推进对局用；不能无界，否则会一直点到超时）。 */
  const clickFor = async (ms: number) => {
    const until = Date.now() + ms
    while (Date.now() < until) { await clickOnce(); await page.waitForTimeout(120) }
  }

  // 打完东1局
  await playUntil(async () => await summary.isVisible())
  await expect(summary, '东1局应结算').toBeVisible({ timeout: 30_000 })
  await summary.getByRole('button', { name: '继续下一局' }).click()

  // 第二局继续点（顺便把第一局的片段顶到刷盘阈值），期间轮询第一局的复现数据是否已落库
  const readFirstRound = async () => page.evaluate(async () => {
    const open = (name: string) => new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    const db = await open('lianhua-guangma-analysis')
    if (!db) return { error: 'no-analysis-db' }
    const readAll = <T,>(target: IDBDatabase, store: string) => new Promise<T[]>((resolve) => {
      const tx = target.transaction(store, 'readonly')
      const request = tx.objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result as T[])
      request.onerror = () => resolve([])
    })
    const blocks = await readAll<{ sequence: number; codec: string; rawBytes: number; storedBytes: number; parts: number; checksum: string; payload: Uint8Array }>(db, 'blocks')
    db.close()
    // 展示回放的各局结束分数在**另一个库**里（§9.3：公开字段以展示回放为唯一来源）。
    // 注意：场次记录要到整场结束（finalize）才落库，此刻能读到的是**各局**记录，因此按局序取分数。
    const replayDb = await open('lianhua-guangma-replay')
    let scores: Array<number[] | null> = []
    if (replayDb) {
      const roundsTable = await readAll<{ matchId: string; index: number; final?: { scores?: number[] } | null }>(replayDb, 'rounds')
      scores = roundsTable.sort((a, b) => a.index - b.index).map(round => round.final?.scores ?? null)
      replayDb.close()
    }
    const { decodeAnalysisBlock } = await import('/src/game/replay/analysis/codec.ts')
    const gathered: Array<{ tag: string; value: Record<string, unknown> }> = []
    for (const block of blocks.sort((a, b) => a.sequence - b.sequence)) {
      const decoded = await decodeAnalysisBlock({
        sequence: block.sequence, codec: block.codec as 'gzip' | 'raw', rawBytes: block.rawBytes,
        storedBytes: block.storedBytes, checksum: block.checksum, parts: block.parts, payload: new Uint8Array(block.payload),
      })
      if (decoded.parts) gathered.push(...(decoded.parts as never))
    }
    const reproductions = gathered.filter(part => part.tag === 'reproduction').map(part => part.value) as Array<{ roundIndex?: number; commands?: Array<{ seat: number; kind: string; windowId?: string; windowKind?: string }> }>
    const first = reproductions.find(record => (record.roundIndex ?? 0) === 1)
    if (!first) return { error: 'not-yet', parts: gathered.length }
    const { replayReproduction } = await import('/src/game/replay/analysis/replayReproduction.ts')
    const commands = first.commands ?? []
    const result = replayReproduction({
      reproduction: first as never, commands: commands as never,
      ...(scores[0] ? { expectedScores: scores[0] as number[] } : {}),
    })
    const decisions = gathered.filter(part => part.tag === 'decision').map(part => part.value as { seat?: number; source?: string })
    return {
      error: '',
      commands: commands.length,
      humanCommands: commands.filter(command => command.seat === 0).length,
      humanDecisions: decisions.filter(decision => decision.seat === 0 && decision.source === 'human').length,
      windowsWithoutId: commands.filter(command => !command.windowId).length,
      kindsWithoutKind: commands.filter(command => !command.windowKind).length,
      ok: result.ok, reason: result.reason, progress: `${result.submitted}/${result.recorded}`,
      kindMismatches: result.kindMismatches, scoresMatch: result.scoresMatch,
      trace: commands.slice(0, 5).map(command => `${command.seat}:${command.kind}`).join(' '),
    }
  })

  const deadline = Date.now() + 420_000
  let first: Awaited<ReturnType<typeof readFirstRound>> = { error: 'timeout' }
  while (Date.now() < deadline) {
    first = await readFirstRound()
    if (first.error === '') break
    await clickFor(3_000)   // 有界推进第二局（顺便把第一局的尾块顶到刷盘阈值）
  }

  console.log(`[analysis-human-round] ${JSON.stringify(first)}`)
  expect(first.error, '东1局的复现数据应随第二局的记录刷进分析区').toBe('')
  const entry = first as {
    commands: number; humanCommands: number; humanDecisions: number
    windowsWithoutId: number; kindsWithoutKind: number
    ok: boolean; reason: string | null; progress: string; kindMismatches: number; scoresMatch: boolean | null; trace: string
  }
  expect(entry.humanDecisions, '人类决策应标为 human 来源').toBeGreaterThan(0)
  expect(entry.humanCommands, '人类自己的命令必须在记录里').toBeGreaterThan(0)
  expect(entry.windowsWithoutId).toBe(0)
  expect(entry.kindsWithoutKind).toBe(0)
  expect(entry.reason, `人类座位打完整局也要能复现：${entry.trace}`).toBeNull()
  expect(entry.ok).toBe(true)
  expect(entry.progress.split('/')[0]).toBe(entry.progress.split('/')[1])
  expect(entry.kindMismatches).toBe(0)
  expect(entry.scoresMatch, '有展示回放快照时必须逐家一致').toBe(true)
  expect(errors).toEqual([])
})
