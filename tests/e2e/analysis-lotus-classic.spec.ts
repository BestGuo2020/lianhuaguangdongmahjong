import { expect, test, type Page } from '@playwright/test'

// 莲花广麻 P0 分析记录（约定 §9 的 DoD）。
//
// 三条用例，两条路径：
//
// **引擎级探针**（`analysis-lotus-classic.html` fixture：真实 useGame + 真实分析区，但不经由 App）：
//   ① 开关打开跑完整场 → 从**分析库**读回 → parts 形状、行内状态「分析：完整」、
//      导出包自包含（记录 + 被引用配置 + 展示回放）；
//   ② 开关关掉 → 零写入（库里不多一场、块数为 0）；
//   ③ 开/关两种设置下同一场（同一随机序列）的**结束分数与动作数完全一致**（硬护栏）。
//
// **app-path**（§9 追加的必做项：真实 App + 真实大厅流程，不由 fixture 注入 recorder）：
//   ④ 正向：从大厅开一场莲花广麻 → 打到一个落库点 → 从分析库读回 `parts > 0` 且
//      `rulesetId === 'lotus-classic'` —— 锁住协调者在 App.vue 里补的 `analysis: analysis.port`
//      那一行，以及 `rulesetId` 按 `selectedRule` 取值（不是硬编码血流）；
//   ⑤ 负向：开关关掉走同一流程 → 库里零新增（那一行"既接上了、又听开关"两头都锁住）。
test.setTimeout(300_000)

interface ProbeStatus {
  ready: boolean
  error: string | null
  errors: string[]
  off: {
    finished: boolean
    rounds: number
    events: number
    eventTrace: string[]
    scores: number[]
    matchesBefore: number
    matchesAfter: number
    blocksForMatch: number
  }
  on: {
    finished: boolean
    rounds: number
    events: number
    eventTrace: string[]
    scores: number[]
    matchId: string
    status: string | null
    label: string
    partsByTag: Record<string, number>
    partsTotal: number
    windows: number
    choices: number
    receipts: number
    uniqueWindowIds: boolean
    choicesResolvable: boolean
    settlementsBalanced: boolean
    settlements: number
    exportManifest: Record<string, unknown> | null
    exportBytes: number
    exportMissing: string[]
    exportReproductionCapable: boolean
    records: number
    configurations: number
    replayRounds: number
  }
}

const FIXTURE = '/tests/e2e/fixtures/analysis-lotus-classic.html'

test('莲花广麻：记录落库形状、行内状态、导出自包含、开关关掉零写入、记录不影响对局', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(FIXTURE)
  await page.waitForFunction(() => {
    const probe = (window as unknown as { __analysisClassic?: ProbeStatus }).__analysisClassic
    return Boolean(probe?.ready || probe?.error)
  }, undefined, { timeout: 240_000 })
  const probe = await page.evaluate(
    () => (window as unknown as { __analysisClassic: ProbeStatus }).__analysisClassic,
  )

  expect(probe.error, `探针出错：${probe.error}`).toBeNull()
  expect(probe.errors, `录制报错：${probe.errors.join(' | ')}`).toEqual([])
  expect(pageErrors).toEqual([])

  // ③ 硬护栏：记录是纯旁路 —— 同一随机序列下开/关记录的对局必须逐项相同
  expect(probe.off.finished).toBe(true)
  expect(probe.on.finished).toBe(true)
  expect(probe.on.rounds).toBe(probe.off.rounds)
  expect(probe.on.scores, '开/关分析记录的结束分数必须一致').toEqual(probe.off.scores)
  expect(probe.on.events, '开/关分析记录的动作数必须一致').toBe(probe.off.events)
  expect(probe.on.eventTrace).toEqual(probe.off.eventTrace)

  // ② 开关关掉：零写入
  expect(probe.off.matchesAfter, '关掉开关不应在分析库里多出任何一场').toBe(probe.off.matchesBefore)
  expect(probe.off.blocksForMatch, '关掉开关不应写入任何分块').toBe(0)

  // ① 开关打开：记录真的写进去了
  expect(probe.on.matchId).toBe('e2e-lotus-classic')
  expect(probe.on.windows).toBeGreaterThan(0)
  expect(probe.on.choices).toBe(probe.on.windows)
  expect(probe.on.receipts).toBeGreaterThan(0)
  expect(probe.on.uniqueWindowIds, '窗口 ID 必须本局内唯一').toBe(true)
  expect(probe.on.choicesResolvable, '每条选择的 ID 必须落在该窗口的合法动作里').toBe(true)
  expect(probe.on.partsTotal).toBeGreaterThan(0)

  // parts 形状：配置 + 前态 + 决策 + 结算；响应窗口另外按 §9.3 写一条该座位的手牌检查点。
  // 本轮没有 LLM 座位（无 llm 段）、没有中途退出（无 gaps 段）。
  expect(probe.on.partsByTag.config).toBeGreaterThanOrEqual(1)
  expect(probe.on.partsByTag.decisionState).toBeGreaterThan(0)
  expect(probe.on.partsByTag.decision).toBeGreaterThan(0)
  expect(probe.on.partsByTag.settlement).toBeGreaterThan(0)
  expect(probe.on.partsByTag.responderCheckpoint).toBeGreaterThan(0)
  expect(probe.on.partsByTag.llm ?? 0).toBe(0)
  expect(probe.on.partsByTag.gaps ?? 0).toBe(0)
  expect(Object.keys(probe.on.partsByTag).sort())
    .toEqual(['config', 'decision', 'decisionState', 'responderCheckpoint', 'settlement'])

  // 结算四家变化之和恒为 0（§5）
  expect(probe.on.settlementsBalanced, '结算必须四家守恒').toBe(true)

  // 落库状态与行内文案：等价于列表行的「分析：完整」
  expect(probe.on.status).toBe('complete')
  expect(probe.on.label).toBe('分析：完整')

  // 导出包自包含：记录 + 被引用配置 + 展示回放
  const manifest = probe.on.exportManifest as {
    recordsTotal: number
    configurations: number
    replayRounds: number
    includesReplay: boolean
    configReferencesClosed: boolean
    missing: string[]
  }
  expect(manifest).toBeTruthy()
  expect(probe.on.records).toBe(probe.on.partsTotal)
  expect(manifest.configurations).toBeGreaterThanOrEqual(1)
  expect(manifest.configReferencesClosed, '被引用的配置必须都在导出包里').toBe(true)
  expect(manifest.replayRounds).toBeGreaterThan(0)
  expect(manifest.includesReplay).toBe(true)
  expect(probe.on.exportBytes).toBeGreaterThan(0)
  // P0 不做赛后复现（§6 是 P1）：唯一缺的应当只有复现数据这一项，不是"记录/配置/回放缺了"
  expect(probe.on.exportMissing).toEqual(['复现数据（reproduction）'])
  expect(probe.on.exportReproductionCapable).toBe(false)
})
// ─────────────────────────── app-path（§9 追加的必做项） ───────────────────────────

/**
 * 打到"真的落库"需要结算几局。**实测值**：正向在第 2 局结算前后、约 160s 时由自动刷盘落库
 * （见用例输出）；这里取 3（实测 + 1 局余量）作为负向用例的推进下限。
 *
 * 为什么负向必须推进到同一量级：推进量不足的负向用例即使开关坏了也会读到 0
 *（记录是缓冲写，压根还没到落库点），那就不是对照，只是空断言。
 */
const ROUNDS_TO_FLUSH = 3

/** 真实 App 路径：从大厅开一场「莲花广麻」东风场。 */
async function openLotusClassicMatch(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('radio', { name: /单机对战/ }).click()
  await page.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  // 单机默认允许血流 ⇒ 选择器里有三个玩法，显式点「莲花广麻」
  //（'莲花麻将' 与 '莲花麻将·血流' 都不含这串字，所以这个过滤器是唯一的）
  await page.locator('.picker-options button').filter({ hasText: '莲花广麻' }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await page.locator('.start-button').click()
}

interface AnalysisDbReading {
  ok: boolean
  blocks: number
  parts: number
  tags: Record<string, number>
  matchId: string | null
  rulesetId: string | null
  status: string | null
}

/**
 * 读分析库：解码全部分块取记录 + 读场次元数据。gzip 那段直接复用探针的 codec
 * （走 dev server 的模块动态 import，与 analysis-human-round.spec.ts 同一手法）。
 */
function readAnalysisDb(page: Page): Promise<AnalysisDbReading> {
  return page.evaluate(async () => {
    const DB_NAME = 'lianhua-guangma-analysis'
    const empty = {
      ok: false, blocks: 0, parts: 0, tags: {}, matchId: null, rulesetId: null, status: null,
    } as { ok: boolean; blocks: number; parts: number; tags: Record<string, number>
      matchId: string | null; rulesetId: string | null; status: string | null }
    // 关键：`indexedDB.open` 对不存在的库会**新建**一个空库（没有任何 object store），
    // 再去开 idb 事务就会抛 NotFoundError。所以先问一句"这个库存在吗"；不存在就返回空读数
    //（负向用例里这个库本来就不该被建出来）。
    const databases = await indexedDB.databases?.().catch(() => null)
    if (databases && !databases.some((entry) => entry.name === DB_NAME)) return empty

    const openDb = (name: string) => new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    const readAll = <T,>(db: IDBDatabase, store: string) => new Promise<T[]>((resolve) => {
      try {
        const tx = db.transaction(store, 'readonly')
        const request = tx.objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result as T[])
        request.onerror = () => resolve([])
      } catch {
        // 库在但表还没建出来（建到一半）：当作"没有数据"，别让读库本身炸掉
        resolve([])
      }
    })
    const db = await openDb(DB_NAME)
    if (!db) return empty
    const blocks = await readAll<{
      sequence: number; codec: 'gzip' | 'raw'; rawBytes: number
      storedBytes: number; parts: number; checksum: string; payload: Uint8Array
    }>(db, 'blocks')
    const matches = await readAll<{ matchId: string; rulesetId: string; status?: string }>(db, 'matches')
    db.close()
    const { decodeAnalysisBlock } = await import('/src/game/replay/analysis/codec.ts')
    const tags: Record<string, number> = {}
    let parts = 0
    for (const block of blocks.sort((a, b) => a.sequence - b.sequence)) {
      const decoded = await decodeAnalysisBlock({
        sequence: block.sequence, codec: block.codec, rawBytes: block.rawBytes,
        storedBytes: block.storedBytes, checksum: block.checksum, parts: block.parts,
        payload: new Uint8Array(block.payload),
      })
      for (const part of decoded.parts ?? []) {
        parts += 1
        tags[part.tag] = (tags[part.tag] ?? 0) + 1
      }
    }
    const meta = matches[0] ?? null
    return {
      ok: true, blocks: blocks.length, parts, tags,
      matchId: meta?.matchId ?? null, rulesetId: meta?.rulesetId ?? null, status: meta?.status ?? null,
    }
  })
}

/** 读到分析库里有记录为止（落库是异步的：队列触发与 IDB 事务完成之间还有一步）。 */
async function waitForFlushed(page: Page, timeoutMs: number): Promise<AnalysisDbReading> {
  const deadline = Date.now() + timeoutMs
  let reading = await readAnalysisDb(page)
  while (reading.parts === 0 && Date.now() < deadline) {
    await page.waitForTimeout(500)
    reading = await readAnalysisDb(page)
  }
  return reading
}

/**
 * 人类回合点一次牌：被问到鸣牌就过，否则点**内层**牌元素。
 * 外层 `.hand-tile-slot` 上只有 pointer 手势（§9.1 第 3 条），直接 click 只做到"选中"、不会打出；
 * 「托管」按钮单机也没有（§9.1 第 2 条，它是 `v-if="showAutoPlay"`），所以只能自己点。
 */
async function clickOnce(page: Page): Promise<void> {
  const pass = page.locator('.action-bar').getByRole('button', { name: '过', exact: true })
  if (await pass.count() && await pass.isVisible()) {
    await pass.click({ timeout: 3_000 }).catch(() => {})
    return
  }
  const tiles = page.locator('.hand-tile-slot .mahjong-tile:not(.disabled)')
  if (await tiles.count()) await tiles.last().click({ timeout: 5_000 }).catch(() => {})
}

/** 结算面板相关定位（选择器取自 SettlementOverlay.vue）。 */
function settlementLocators(page: Page) {
  const roundPanel = page.locator('.result-backdrop.round-settlement')
  const finalPanel = page.locator('[data-result-kind="final"]')
  const continueButton = roundPanel
    .locator('.settlement-footer .result-actions button')
    .filter({ hasText: '继续' })
    .first()
  return { roundPanel, finalPanel, continueButton }
}

interface AdvanceResult { rounds: number; clicks: number; finished: boolean; flushed: boolean; elapsedMs: number }

/**
 * 推进真实对局直到 `shouldStop` 说停（或到 deadline 为止）。
 *
 * 两个必须处理的点：
 * - **一局结束要点「继续」**，否则对局永远停在结算面板上（实测踩过：点了一千多次手牌，
 *   其实第一局早已结算，记录一条都没产生）；
 * - **落库是缓冲写**（§9.1 第 1 条）：`flushProbe` 每次轮询分析库，落库那一刻就能提前收工；
 *   真正保底的是场末（App 的 `matchFinished` → `analysis.finish()`）与自动刷盘两个点。
 */
async function advanceMatch(
  page: Page,
  shouldStop: (state: { rounds: number; finished: boolean; flushed: boolean }) => boolean,
  deadlineMs: number,
  flushProbe?: () => Promise<boolean>,
): Promise<AdvanceResult> {
  const startedAt = Date.now()
  const { roundPanel, finalPanel, continueButton } = settlementLocators(page)
  let rounds = 0
  let clicks = 0
  let finished = false
  let flushed = false
  let panelCounted = false
  let nextProbe = Date.now() + 1_500
  while (Date.now() - startedAt < deadlineMs) {
    finished = await finalPanel.isVisible().catch(() => false)
    if (flushProbe && Date.now() >= nextProbe) {
      flushed = await flushProbe()
      nextProbe = Date.now() + 1_500
    }
    if (shouldStop({ rounds, finished, flushed })) break
    if (await roundPanel.isVisible().catch(() => false)) {
      if (!panelCounted) { panelCounted = true; rounds += 1 }
      await continueButton.click({ timeout: 5_000 }).catch(() => {})
      await page.waitForTimeout(200)
      continue
    }
    panelCounted = false
    await clickOnce(page)
    clicks += 1
    await page.waitForTimeout(120)
  }
  return { rounds, clicks, finished, flushed, elapsedMs: Date.now() - startedAt }
}

/**
 * 正向：真实 App 路径把莲花广麻的记录写进分析库。
 * 这条用例证明的是引擎级探针**证明不了**的东西：App.vue 里那一行端口传递真的接上了。
 *
 * 慢：单机得推进到落库点（自动刷盘约在第 3 局前后，或整场结束）。所以超时放宽到 15 分钟，
 * 用时与观测数字写在用例输出里。
 */
test('app-path：真实 App 开一场莲花广麻 → 分析库读回 parts>0 且 rulesetId=lotus-classic', async ({ page }) => {
  test.setTimeout(900_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await openLotusClassicMatch(page)
  const advance = await advanceMatch(
    page,
    (state) => state.flushed || state.finished,
    420_000,
    async () => (await readAnalysisDb(page)).parts > 0,
  )
  // 到落库点后再给 60s 余量等刷盘完成（§9.1 第 1 条的轮询建议）
  const reading = await waitForFlushed(page, 60_000)
  console.log('[analysis-lotus-classic app-path] '
    + `落库点：结算 ${advance.rounds} 局 / ${advance.clicks} 次点击 / ${Math.round(advance.elapsedMs / 1000)}s / `
    + `场末=${advance.finished} ${advance.flushed ? '（自动刷盘）' : '（场末收尾）'}；`
    + `blocks=${reading.blocks} parts=${reading.parts} `
    + `rulesetId=${reading.rulesetId} status=${reading.status} tags=${JSON.stringify(reading.tags)}`)

  expect(
    reading.parts,
    `真实 App 路径应把记录写进分析库（已结算 ${advance.rounds} 局 / 场末=${advance.finished} / `
    + `${Math.round(advance.elapsedMs / 1000)}s 仍未落库）`,
  ).toBeGreaterThan(0)
  // 锁住 App.vue 里 rulesetId 按 selectedRule 取值那一处（曾经硬编码成血流）
  expect(reading.rulesetId, 'rulesetId 必须是本局所选玩法').toBe('lotus-classic')
  expect(reading.matchId, '应与展示回放共用同一个场次 id').toBeTruthy()
  expect(reading.status).toBeTruthy()
  // 只落了 config 说明引擎那一段没接上：必须有时态与决策
  expect(reading.tags.decisionState ?? 0, '应有决策前态').toBeGreaterThan(0)
  expect(reading.tags.decision ?? 0, '应有决策与选择').toBeGreaterThan(0)
  expect(pageErrors).toEqual([])
})

/**
 * 负向：开关关掉走**同样的对局量** → 库里零新增。
 * 与正向合起来锁住那一行的两头：既接上了（正向），又听开关（负向）。
 * 推进量与正向同一量级（`ROUNDS_TO_FLUSH` 局，正向实测在该量级内就落了库）：
 * 推进量不足的负向用例即使开关坏了也会读到 0，那就不算对照。
 *
 * 慢用例门控（协调者 2026-09-21 决定，见约定 §9.2）：正向那条留在默认套件（2.5 分钟，锁住 App.vue
 * 的端口传递）；这条负向要 3.9 分钟、且与引擎级"开关关掉零写入"重复度高，因此与
 * `analysis-human-round.spec.ts` 同口径 —— 设 `E2E_SLOW=1` 才跑。
 */
test('app-path 负向：开关关掉 → 同一流程零新增（慢用例，E2E_SLOW=1 才跑）', async ({ page }) => {
  test.skip(process.env.E2E_SLOW !== '1', '慢用例：设 E2E_SLOW=1 才运行（约 4 分钟，必须真推进到落库点）')
  test.setTimeout(900_000)
  await page.addInitScript(() => {
    // DEV 下开关默认开启（除非显式置 '0'）：在应用加载前就关掉
    try { localStorage.setItem('lgm_analysis_enabled', '0') } catch { /* 隐私模式：本次会话内生效 */ }
  })
  await openLotusClassicMatch(page)
  const advance = await advanceMatch(
    page,
    (state) => state.rounds >= ROUNDS_TO_FLUSH || state.finished,
    600_000,
  )
  // 再等一会儿让"万一有写入"有机会落库（异步刷盘），否则断言 0 只是因为读得太早
  const reading = await waitForFlushed(page, 15_000)
  console.log('[analysis-lotus-classic app-path 负向] '
    + `结算 ${advance.rounds} 局 / ${advance.clicks} 次点击 / ${Math.round(advance.elapsedMs / 1000)}s / 场末=${advance.finished}；`
    + `blocks=${reading.blocks} parts=${reading.parts} matchId=${reading.matchId}`)

  // 推进到与正向同量级的对局量；若这局提前打完（场末同样是落库点），也算推进到位
  expect(
    advance.rounds >= ROUNDS_TO_FLUSH || advance.finished,
    `负向用例必须推进到与正向同量级（${ROUNDS_TO_FLUSH} 局或打到场末），否则不算对照`,
  ).toBe(true)
  expect(
    reading.parts,
    `开关关掉后推进 ${advance.rounds} 局（正向实测 ${ROUNDS_TO_FLUSH} 局量级内即落库）仍应零记录`,
  ).toBe(0)
  expect(reading.blocks, '开关关掉不应写入任何分块').toBe(0)
  expect(reading.matchId, '开关关掉不应建场').toBeNull()
})