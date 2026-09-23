import { expect, test, type Page } from '@playwright/test'

// 莲花广麻 P0+P1 分析记录（约定 §9 的 DoD；P1 见方案 §4）。
//
// 四条用例，两条路径：
//
// **引擎级探针**（`analysis-lotus-classic.html` fixture：真实 useGame + 真实分析区，但不经由 App）：
//   ① 开关打开跑完整场 → 从**分析库**读回 → parts 形状、行内状态「分析：完整」、
//      导出包自包含（记录 + 被引用配置 + 展示回放）+ 复现数据逐局落库；
//   ② **P1**：从落库读回的复现数据逐局重跑 ⇒ 命令逐条消费、结束分数与记录逐位相同，
//      并做"改一张 postDealHands"的负向对照（必须报不一致且**一条命令都不喂**）；
//   ③ 开关关掉 → 零写入（库里不多一场、块数为 0）；
//   ④ 开/关两种设置下同一场（同一随机序列）的**结束分数与动作数完全一致**（硬护栏）。
//
// **app-path**（§9 追加的必做项：真实 App + 真实大厅流程，不由 fixture 注入 recorder）：
//   ⑤ 正向：从大厅开一场莲花广麻 → 打到一个落库点 → 从分析库读回 `parts > 0` 且
//      `rulesetId === 'lotus-classic'` —— 锁住协调者在 App.vue 里补的 `analysis: analysis.port`
//      那一行，以及 `rulesetId` 按 `selectedRule` 取值（不是硬编码血流）；
//   ⑥ 负向：开关关掉走同一流程 → 库里零新增（那一行"既接上了、又听开关"两头都锁住）。
test.setTimeout(300_000)

// 串行：探针用例之间共享同一个分析库（IndexedDB），并行会互相污染"开关关掉零写入"这类计数。
test.describe.configure({ mode: 'serial' })

/** P1 的确定性重跑需要固定的牌墙与骰子 ⇒ 整场都钉死在这个 seed 上。 */
const SEED = 20_260_921

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
    exportMatchId: string | null
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
    // ── P1（赛后复现）──
    reproductionParts: number
    reproductionRounds: Array<{
      roundIndex: number
      ok: boolean
      reason: string | null
      scoresMatch: boolean | null
      expectedScores: number[] | null
      finalScores: number[]
      kindMismatches: number
      postDealChecked: boolean
      postDealOk: boolean
      openingChecked: boolean
      openingOk: boolean
      windowsOpened: number
      commandsRecorded: number
      commandsConsumed: number
      commandsNotLegalAtRecordTime: number
      withoutWindowId: number
      unusedCommands: number
      nonCommandEntries: number
      gaps: string[]
    }>
    postDealTamper: { ok: boolean; reason: string | null; windowsOpened: number; commandsConsumed: number } | null
  }
}

const FIXTURE = '/tests/e2e/fixtures/analysis-lotus-classic.html'

/** 跑一次探针并把探针自身的错误先卡住（后面的断言才有证据力）。 */
async function runProbe(page: Page, query: string): Promise<ProbeStatus> {
  await page.goto(`${FIXTURE}${query}`)
  await page.waitForFunction(() => {
    const probe = (window as unknown as { __analysisClassic?: ProbeStatus }).__analysisClassic
    return Boolean(probe?.ready || probe?.error)
  }, undefined, { timeout: 280_000 })
  const probe = await page.evaluate(
    () => (window as unknown as { __analysisClassic: ProbeStatus }).__analysisClassic,
  )
  expect(probe.error, `探针出错：${probe.error}`).toBeNull()
  return probe
}

test('莲花广麻：记录落库形状、行内状态、导出自包含、开关关掉零写入、记录不影响对局', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  // `replay=0`：这条用例只看记录形状与导出包（重跑由下面那条 P1 用例负责，避免重复付一次重跑的时间）
  const probe = await runProbe(page, `?replay=0&seed=${SEED}`)

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
  expect(probe.on.matchId).toBeTruthy()
  expect(probe.on.exportMatchId).toBe(probe.on.matchId)
  expect(probe.on.windows).toBeGreaterThan(0)
  expect(probe.on.choices).toBe(probe.on.windows)
  expect(probe.on.receipts).toBeGreaterThan(0)
  expect(probe.on.uniqueWindowIds, '窗口 ID 必须本局内唯一').toBe(true)
  expect(probe.on.choicesResolvable, '每条选择的 ID 必须落在该窗口的合法动作里').toBe(true)
  expect(probe.on.partsTotal).toBeGreaterThan(0)

  // parts 形状：配置 + 前态 + 决策 + 结算 + **复现数据**；响应窗口另外按 §9.3 写一条该座位的手牌检查点。
  // 本轮没有 LLM 座位（无 llm 段）、没有中途退出（无 gaps 段）。
  expect(probe.on.partsByTag.config).toBeGreaterThanOrEqual(1)
  expect(probe.on.partsByTag.decisionState).toBeGreaterThan(0)
  expect(probe.on.partsByTag.decision).toBeGreaterThan(0)
  expect(probe.on.partsByTag.settlement).toBeGreaterThan(0)
  expect(probe.on.partsByTag.responderCheckpoint).toBeGreaterThan(0)
  // P1（§2.1）：复现数据也要落库，且**每一局一条**（打了 N 局就有 N 条可重跑的起点）
  expect(probe.on.partsByTag.reproduction, '每一局都要落一条复现数据').toBe(probe.on.rounds)
  expect(probe.on.partsByTag.llm ?? 0).toBe(0)
  expect(probe.on.partsByTag.gaps ?? 0).toBe(0)
  expect(Object.keys(probe.on.partsByTag).sort())
    .toEqual(['config', 'decision', 'decisionState', 'reproduction', 'responderCheckpoint', 'settlement'])

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
  // P1 之后这一场带着**内容完整**的复现数据 ⇒ 导出包必须如实声称"可以精确复现"（§2.4）。
  // 判据不再是"有没有 reproduction 记录"，而是逐局看字段齐不齐（`reproductionCapability.ts`）——
  // 广麻的清单里**没有**精牌/指示牌那几项（玩法里没有翻精），这正是"按 variant 分派"要立住的事。
  expect(probe.on.exportReproductionCapable, 'P1 起复现数据字段齐全 ⇒ 应当声称可精确复现').toBe(true)
  expect(probe.on.exportMissing, '可精确复现时不该再有任何缺失项').toEqual([])
})

test('P1 赛后复现：从落库读回的复现数据逐局重跑 ⇒ 到达同一结束状态（方案 §2、§4 的 DoD）', async ({ page }) => {
  // 这条是 P1 的核心验收点：**不是**读字段对不对，而是拿记录里的"环状牌墙 + 开局骰子 + 庄家
  // + 当局开局分 + 权威动作序列"重新跑一局，看能不能到达同一个结束状态（§2.3：不许拿"跑通"当"复现"）。
  //
  // 为什么必须在浏览器里跑：校验器要起真实 `useGame`（Vue 响应式 + 定时器链），
  // vitest 环境里没有这套 DOM/定时器组合（§3.5）。同一段代码在 vitest 里由假时钟驱动
  // （`replayLotusClassicRound.test.ts`，几秒），这里由**真实浏览器定时器**驱动。
  test.setTimeout(900_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const probe = await runProbe(page, `?seed=${SEED}`)

  expect(pageErrors, `页面报错：${pageErrors.join(' | ')}`).toEqual([])
  expect(probe.errors, `录制报错：${probe.errors.join(' | ')}`).toEqual([])
  expect(probe.on.rounds, '应当打完东风场').toBeGreaterThanOrEqual(4)
  console.log(`[analysis-lotus-classic] P1 重跑：复现数据 ${probe.on.reproductionParts} 条；`
    + `逐局 ${probe.on.reproductionRounds.map((run) => `#${run.roundIndex} ok=${run.ok}`
      + ` 命令 ${run.commandsConsumed}/${run.commandsRecorded} 窗口 ${run.windowsOpened}`
      + ` 分数 ${run.finalScores.join('/')}`).join(' | ')}；`
    + `篡改对照 ok=${probe.on.postDealTamper?.ok} 命令 ${probe.on.postDealTamper?.commandsConsumed}`)

  // 复现数据逐局落库（跳过的局会在 `partsByTag.reproduction` 上少一条）
  expect(probe.on.reproductionParts, '每一局都要有复现数据').toBe(probe.on.rounds)
  expect(probe.on.reproductionRounds, '每一局都要真的重跑一次').toHaveLength(probe.on.reproductionParts)

  for (const run of probe.on.reproductionRounds) {
    const where = `第 ${run.roundIndex} 局`
    expect(run.ok, `${where}重跑未到达同一结束状态：${run.reason ?? '（没有给出原因，这本身就是缺陷）'}`).toBe(true)
    // ① 发牌后的手牌必须**交叉校验过**并且一致（§3.3）：这一步不一致就说明"发牌算法变了或记录与引擎不一致"
    expect(run.postDealChecked, `${where}必须做发牌后手牌的交叉校验（没做就等于没验证）`).toBe(true)
    expect(run.postDealOk, `${where}发牌后的手牌必须与记录一致`).toBe(true)
    // ② 开牌断点由"牌墙 + 骰子 + 庄家"推出，重跑推出来的必须与记录一致
    expect(run.openingChecked, `${where}必须校验开牌断点`).toBe(true)
    expect(run.openingOk, `${where}开牌断点必须与记录一致`).toBe(true)
    // ③ 结束分数与记录侧的结算完全一致（"同一结束状态"的机器判据）
    expect(run.expectedScores, `${where}必须有可比的结束分数`).not.toBeNull()
    expect(run.scoresMatch, `${where}结束分数必须与记录一致`).toBe(true)
    expect(run.finalScores, `${where}结束分数`).toEqual(run.expectedScores)
    // ④ 命令日志必须**逐条被消费**：漏跑一条、多跑一条、顺序错了都会在这里露出来（§2.2、§4）
    expect(run.withoutWindowId, `${where}每条命令都要带 windowId（顺序判据）`).toBe(0)
    expect(run.commandsRecorded, `${where}命令日志不能是空的（空的"全对上"是空转）`).toBeGreaterThan(0)
    expect(run.commandsConsumed, `${where}记录里的命令必须全部被消费（不许跳过）`).toBe(run.commandsRecorded)
    expect(run.unusedCommands, `${where}不许有没被消费的命令（重跑提前终局）`).toBe(0)
    // §4「被拒动作不出现」，两个可观测形式都要立住：
    // ① 日志里没有"不是命令口径"的条目（expire/auto 是血流权威端的概念，掺进来必须如实报错而不是过滤掉）；
    // ② 每条命令在记录时都确实落在当时的合法动作里（P0 的合法动作下标 ≥ 0 ⇒ 带 legalActionId）。
    expect(run.nonCommandEntries, `${where}命令日志里不该有非命令口径的条目`).toBe(0)
    expect(run.commandsNotLegalAtRecordTime, `${where}每条命令在记录时都必须是合法动作（不许把被拒动作记进来）`).toBe(0)
    expect(run.kindMismatches, `${where}窗口类型必须逐窗口对上`).toBe(0)
    expect(run.gaps, `${where}重跑期间不得留缝：${run.gaps.join(' | ')}`).toEqual([])
  }
  // 一局至少一手牌，所以整场命令数必然多于局数 —— 顺带证明记的不是"每局一条"那种空壳
  expect(probe.on.reproductionRounds.reduce((total, run) => total + run.commandsRecorded, 0))
    .toBeGreaterThan(probe.on.rounds)

  // ── 负向对照（§3.3、§4）：把记录改一张 ⇒ 必须报"发牌算法变了或记录与引擎不一致"并**停下来** ──
  const tamper = probe.on.postDealTamper
  expect(tamper, '夹具应当做"改了记录"的负向对照').not.toBeNull()
  expect(tamper!.ok, '记录被动过就不能再声称复现成功').toBe(false)
  expect(tamper!.reason, '失败原因必须点明是发牌/记录与引擎不一致').toContain('发牌算法变了或记录与引擎不一致')
  expect(tamper!.commandsConsumed, '发现不一致之后不许再喂任何命令（更不许跳过它把这一局跑完）').toBe(0)
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
