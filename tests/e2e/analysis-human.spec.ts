import { expect, test } from '@playwright/test'

// 人类座位的分析记录（§10.6、§10.1、§3.4）：
// 1. 真人对局提交的是 send()，与机器人分支不同 —— 人类自己的命令必须进记录，且带窗口归属与窗口类型；
// 2. 记录与权威**不一致**时，复现必须明确报错，绝不能悄悄跑完（这正是 §10.6 的判据价值）。
//
// 这里用一个刻意"失真"的加速手段同时覆盖两件事：worker 收到 start 时把牌墙清空（牌挪进庄家牌河，
// 保持 136 张守恒）⇒ 每局一两手就荒庄、几十秒跑完一场；但主线程记录的初始牌墙仍是 81 张，
// 于是重放必然与权威对不上（实测四局都报"命令序列不完整"）。
// 想要"人类对局也能复现成功"的端到端验证，需要不改造牌墙打完整局（约 4 分钟/局），
// 因此没有纳入常规 e2e；记录形状与判据行为由本用例覆盖，逐局复现由 analysis-probe / replay.spec 覆盖。
test.setTimeout(240_000)

test('人类座位的命令进复现记录，且记录与权威不一致时复现明确报错', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker
    window.Worker = class extends OriginalWorker {
      postMessage(message: { kind?: string; options?: { opening?: { players: Array<{ discards: string[] }>; wall: string[] } } }, transfer?: Transferable[]) {
        if (message.kind === 'start' && message.options?.opening) {
          const opening = message.options.opening
          opening.players[0].discards.push(...opening.wall.splice(0))
        }
        super.postMessage(message, transfer ?? [])
      }
    } as typeof Worker
  })

  await page.goto('/?bloodFlow=1')
  await page.getByRole('radio', { name: /单机对战/ }).click()
  await page.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  await page.getByRole('button', { name: /莲花麻将·血流/ }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await page.locator('.start-button').click()

  const enabledTiles = page.locator('.hand-tile-slot .mahjong-tile:not(.disabled)')
  const summary = page.getByRole('dialog', { name: /血流(本局结算|最终排名|公开流水)/ })
  for (let round = 1; round <= 4; round += 1) {
    const until = Date.now() + 60_000
    while (Date.now() < until && !(await summary.isVisible())) {
      const pass = page.locator('.action-bar').getByRole('button', { name: '过', exact: true })
      if (await pass.count() && await pass.isVisible()) await pass.click({ timeout: 3_000 }).catch(() => {})
      else if (await enabledTiles.count()) await enabledTiles.last().click({ timeout: 5_000 }).catch(() => {})
      await page.waitForTimeout(150)
    }
    await expect(summary, `第 ${round} 局应结算`).toBeVisible({ timeout: 20_000 })
    if (round < 4) await summary.getByRole('button', { name: '继续下一局' }).click()
  }

  // 整场结束 ⇒ App 调 analysis.finish() 刷队列落库
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open('lianhua-guangma-analysis')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    if (!db) return 'no-db'
    const statuses = await new Promise<string[]>((resolve) => {
      const tx = db.transaction('matches', 'readonly')
      const request = tx.objectStore('matches').getAll()
      request.onsuccess = () => resolve((request.result as Array<{ status: string }>).map(entry => entry.status))
      request.onerror = () => resolve([])
    })
    db.close()
    return statuses.join(',')
  }), { timeout: 60_000, intervals: [500] }).toBe('complete')

  const collected = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open('lianhua-guangma-analysis')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    if (!db) return { error: 'no-analysis-db', results: [], humanDecisions: 0 }
    const blocks = await new Promise<Array<{ sequence: number; codec: string; rawBytes: number; storedBytes: number; parts: number; checksum: string; payload: Uint8Array }>>((resolve) => {
      const tx = db.transaction('blocks', 'readonly')
      const request = tx.objectStore('blocks').getAll()
      request.onsuccess = () => resolve(request.result as never)
      request.onerror = () => resolve([])
    })
    db.close()
    const { decodeAnalysisBlock } = await import('/src/game/replay/analysis/codec.ts')
    const { replayReproduction } = await import('/src/game/replay/analysis/replayReproduction.ts')
    const gathered: Array<{ tag: string; value: Record<string, unknown> }> = []
    for (const block of blocks.sort((a, b) => a.sequence - b.sequence)) {
      const decoded = await decodeAnalysisBlock({
        sequence: block.sequence, codec: block.codec as 'gzip' | 'raw', rawBytes: block.rawBytes,
        storedBytes: block.storedBytes, checksum: block.checksum, parts: block.parts, payload: new Uint8Array(block.payload),
      })
      if (decoded.parts) gathered.push(...(decoded.parts as never))
    }
    const reproductions = gathered.filter(part => part.tag === 'reproduction').map(part => part.value) as Array<{ roundIndex?: number; initialWall?: string[]; commands?: Array<{ seat: number; kind: string; windowId?: string; windowKind?: string }> }>
    const decisions = gathered.filter(part => part.tag === 'decision').map(part => part.value as { seat?: number; source?: string })
    const results = reproductions.map((record) => {
      const commands = record.commands ?? []
      const result = replayReproduction({ reproduction: record as never, commands: commands as never })
      return {
        roundIndex: record.roundIndex ?? 0,
        wall: (record.initialWall ?? []).length,
        commands: commands.length,
        humanCommands: commands.filter(command => command.seat === 0).length,
        firstCommand: commands.length ? `${commands[0].seat}:${commands[0].kind}` : '-',
        windowsWithoutId: commands.filter(command => !command.windowId).length,
        kindsWithoutKind: commands.filter(command => !command.windowKind).length,
        ok: result.ok, reason: result.reason, progress: `${result.submitted}/${result.recorded}`,
      }
    })
    return { error: '', results, humanDecisions: decisions.filter(decision => decision.seat === 0 && decision.source === 'human').length }
  })

  expect(collected.error).toBe('')
  console.log(`[analysis-human] ${collected.results.map(entry => `第${entry.roundIndex}局 ${entry.progress}${entry.ok ? ' ok' : ' 报错'}（人类命令 ${entry.humanCommands}，牌墙 ${entry.wall}）`).join('  ')}；人类决策 ${collected.humanDecisions} 条`)

  expect(collected.results.length, '每局都应有一条复现数据').toBe(4)
  expect(collected.humanDecisions, '人类决策必须如实标为 human 来源（§10.1）').toBeGreaterThan(0)
  const first = collected.results[0]
  expect(first.wall, '记录的是主线程的初始牌墙（加速改造只动权威，故这里是 81）').toBe(81)
  // 人类（0 号座）在第 1 局是庄家：记录的第一条命令必须是人类自己的出牌 ——
  // 这条断言挡住"人类命令被算到下一局"的回归（曾经因为等回复才入列，快照已经先发生）。
  expect(first.firstCommand, '第 1 局第一条命令应是人类出牌').toBe('0:discard')
  expect(first.humanCommands, '人类自己的命令必须在记录里（本用例针对 send() 分支）').toBeGreaterThan(0)
  for (const entry of collected.results) {
    expect(entry.windowsWithoutId, '命令必须带 windowId').toBe(0)
    expect(entry.kindsWithoutKind, '命令必须带 windowKind').toBe(0)
    // 记录与权威不一致 ⇒ 必须明确报错，不得悄悄跑完（§10.6、§9.5）
    expect(entry.ok, `记录与权威不一致时不得判为复现成功（第 ${entry.roundIndex} 局）`).toBe(false)
    expect(entry.reason, `第 ${entry.roundIndex} 局必须给出确切原因`).toBeTruthy()
  }
  expect(errors).toEqual([])
})
