import { expect, test } from '@playwright/test'

// 「莲花麻将·翻精癞子」分析记录的端到端（约定 §9 的 P0）：
// ① 真实引擎 + 真实分析区跑完一场 ⇒ 从 IndexedDB 读回，断言记录形状（config/decisionState/decision/settlement）、
//    前态与决策一一对应、窗口 ID 唯一、结算四家变化之和为 0、行内状态「分析：完整」（读的是同一份落库状态）；
// ② 导出包自包含（记录 + 被引用配置 + 展示回放）；
// ③ 开关关掉后**零写入**；
// ④ 硬护栏：同一副牌（固定牌墙 + 固定随机流）在"分析开/关"两种设置下，结束分数与动作数完全一致。
//
// 为什么走夹具而不是真实 App：`src/App.vue` 在协调者的冻结清单里（约定 §3），给 `useLotusGame` 传
// `analysis: analysis.port` 的那一行由协调者走「公共改动」提交。夹具按与 App 同一套接线直接挂载引擎，
// 记录链路完全同源；差的只是"大厅列表行内状态"那一层 UI —— 用例里断言的是它读的那个落库状态。
test.setTimeout(300_000)

const FIXTURE = '/tests/e2e/fixtures/analysis-lotus-legacy.html'
const SEED = 20_260_921

interface ProbeStatus {
  ready: boolean
  error: string | null
  errors: string[]
  analysisEnabled: boolean
  seed: number | null
  matchId: string
  storedStatus: string | null
  partsByTag: Record<string, number>
  decisionsBySource: Record<string, number>
  decisionWindowIds: string[]
  decisionStateIds: string[]
  distinctDecisions: number
  decisionsWithoutWindowId: number
  windowIdSeatConflicts: number
  decisionsWithoutState: number
  decisionStatesWithoutActions: number
  settlements: Array<{ roundIndex: number; deltas: number[]; sum: number; kind: string; winners: number[] }>
  settlementsNotBalanced: number
  replayRounds: number
  gameEvents: { roundStart: number; draw: number; discard: number; tableAction: number; roundEnd: number }
  finalScores: number[]
  roundsPlayed: number
  exportManifest: {
    recordsTotal: number
    configurations: number
    includesReplay: boolean
    configReferencesClosed: boolean
    replayRounds: number
    missing: string[]
  } | null
  reproductionCapable: boolean | null
  storageBlocks: number
  storageMatches: number
  storageAvailable: boolean
  rngDraws: number
}

async function runProbe(page: import('@playwright/test').Page, query: string): Promise<ProbeStatus> {
  await page.goto(`${FIXTURE}${query}`)
  await expect(page.locator('body')).toHaveCount(1)
  await page.waitForFunction(() => {
    const probe = (window as unknown as { __lotusLegacyProbe?: ProbeStatus }).__lotusLegacyProbe
    return Boolean(probe?.ready || probe?.error)
  }, undefined, { timeout: 280_000 })
  const probe = await page.evaluate(() => (window as unknown as { __lotusLegacyProbe: ProbeStatus }).__lotusLegacyProbe)
  expect(probe.error, `夹具自身出错：${probe.error}`).toBeNull()
  // 录制侧不得报错：分析记录是旁路观测，出问题只能留痕、不能影响对局（§10.2）
  expect(probe.errors, `录制报错：${probe.errors.join(' | ')}`).toEqual([])
  return probe
}

test.describe.configure({ mode: 'serial' })

test('翻精癞子：真实引擎跑完一场 → 记录形状、遮蔽、窗口 ID、结算守恒、导出包自包含', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const probe = await runProbe(page, `?analysis=1&seed=${SEED}`)

  expect(pageErrors, `页面报错：${pageErrors.join(' | ')}`).toEqual([])
  expect(probe.storageAvailable, '分析区应当可用（否则下面的断言没有证据力）').toBe(true)
  // 东风场是 4 个**局号**，但连庄（庄家和牌／荒庄听牌）会让实际打完的局数多于 4：
  // 记录侧一律按"已打局数"编号（与展示回放同一套口径），所以这里只要求不少于 4。
  expect(probe.roundsPlayed, '应当打完东风场').toBeGreaterThanOrEqual(4)
  expect(probe.gameEvents.roundEnd, '每局都要有局末结算').toBe(probe.roundsPlayed)
  const roundIndexes = probe.settlements.map((entry) => entry.roundIndex).sort((a, b) => a - b)
  console.log(`[analysis-lotus-legacy] 场次 ${probe.matchId} 状态 ${probe.storedStatus}；`
    + `打了 ${probe.roundsPlayed} 局（连庄在内）；记录 ${JSON.stringify(probe.partsByTag)}；`
    + `决策来源 ${JSON.stringify(probe.decisionsBySource)}；结算 ${probe.settlements.length} 条；`
    + `展示回放 ${probe.replayRounds} 局 / 动作 ${JSON.stringify(probe.gameEvents)}`)

  // ── ① 落库状态：列表行内「分析：完整」读的就是它（§9.2）──
  expect(probe.storedStatus, '这一场必须落成「完整」').toBe('complete')
  expect(probe.matchId, '场次 id 必须与展示回放共用').toBeTruthy()

  // ── ② 记录形状：四类记录都要有；llm 只在接了模型钩子后才有（本阶段没有）──
  expect(probe.partsByTag.config, '场次配置必须落库').toBeGreaterThan(0)
  expect(probe.partsByTag.decisionState, '决策前态必须落库').toBeGreaterThan(0)
  expect(probe.partsByTag.decision, '决策必须落库').toBeGreaterThan(0)
  expect(probe.partsByTag.settlement, '结算必须落库').toBeGreaterThan(0)
  expect(probe.partsByTag.llm ?? 0, '本阶段 LLM 座位未接钩子 ⇒ 不应有 llm 记录').toBe(0)

  // ── ③ 人类 + 本地 AI 座位的来源如实标注（§3.4）：LLM 未接线 ⇒ 只能是这两种 ──
  expect(probe.decisionsBySource.human, '人类座位必须有决策记录').toBeGreaterThan(0)
  expect(probe.decisionsBySource['rule-auto'], '本地 AI 座位必须有决策记录').toBeGreaterThan(0)
  expect(Object.keys(probe.decisionsBySource).sort(), '本阶段不该出现 model/model-fallback（钩子未接）')
    .toEqual(['human', 'rule-auto'])

  // ── ④ 窗口 ID 唯一且每条决策都带；一个窗口只属于一个座位；前态与决策一一对应（§3.1、§3.2）──
  expect(probe.decisionsWithoutWindowId, '窗口 ID 不得缺失（§3.1：缺 ID 的条目数为 0）').toBe(0)
  expect(probe.windowIdSeatConflicts, '一个窗口只能属于一个座位').toBe(0)
  expect(probe.decisionsWithoutState, '每条决策都要有对应的前态').toBe(0)
  expect(probe.decisionStatesWithoutActions, '每份前态都要带合法动作').toBe(0)
  // 一个 (窗口, 座位) = 一份前态 = 一条决策
  expect(probe.distinctDecisions, '去重后的决策数应与前态数一致').toBe(probe.decisionStateIds.length)
  expect(new Set(probe.decisionWindowIds).size, '窗口 ID 不得重复').toBe(probe.decisionWindowIds.length)

  // ── ⑤ 结算折算：每局一条，四家变化之和为 0（§5）──
  expect(probe.settlementsNotBalanced, '四家分数变化之和必须为 0').toBe(0)
  expect(probe.settlements.length, '每一局都要有一条结算').toBe(probe.gameEvents.roundEnd)
  // 局号按"已打局数"逐局递增（连庄不重复、不跳号）——这正是不能用 `state.round` 当键的原因
  expect(roundIndexes).toEqual(Array.from({ length: probe.roundsPlayed }, (_, index) => index + 1))
  for (const settlement of probe.settlements) {
    expect(settlement.deltas, `第 ${settlement.roundIndex} 局的 delta 必须是四家`).toHaveLength(4)
    expect(settlement.sum, `第 ${settlement.roundIndex} 局分数变化之和`).toBe(0)
  }

  // ── ⑥ 导出包自包含：记录 + 被引用配置 + 展示回放（§9.1）──
  const manifest = probe.exportManifest
  expect(manifest, '应当能构建导出包').not.toBeNull()
  expect(manifest!.recordsTotal).toBeGreaterThan(0)
  expect(manifest!.configurations, '被引用的配置必须随包带走').toBeGreaterThan(0)
  expect(manifest!.configReferencesClosed, '引用要闭合：不能只有 id 没有正文').toBe(true)
  expect(manifest!.includesReplay, '公开字段的唯一来源是展示回放，必须随包带走').toBe(true)
  expect(manifest!.replayRounds, '展示回放应当带上这一场打过的每一局').toBe(probe.roundsPlayed)
  // P0 不含赛后复现（§6，P1）：如实标成"不能精确复现"，并把原因写在 missing 里 —— 不得谎称可复现
  expect(probe.reproductionCapable, 'P0 没有复现数据 ⇒ 不得声称可精确复现').toBe(false)
  expect(manifest!.missing.some((entry) => entry.includes('复现数据')), '缺少复现数据的原因必须如实标注').toBe(true)
})

test('翻精癞子：分析开关关掉后零写入', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const probe = await runProbe(page, `?analysis=0&seed=${SEED}`)

  expect(pageErrors).toEqual([])
  expect(probe.analysisEnabled).toBe(false)
  expect(probe.roundsPlayed, '关掉分析也要能把整场打完').toBeGreaterThanOrEqual(4)
  expect(probe.storageAvailable, '分析区仍然可用 —— 所以下面的 0 是"没写"而不是"写不进去"').toBe(true)
  // 关掉分析 ⇒ 一条记录都不产生（§9.2、§10.7：关闭时零成本、零写入）
  expect(probe.storageBlocks, '关掉分析后不得有任何分析块').toBe(0)
  expect(probe.storageMatches, '关掉分析后不得有场次元数据').toBe(0)
  expect(Object.keys(probe.partsByTag), '关掉分析后不得有任何记录').toEqual([])
  expect(probe.matchId, '关掉分析时不开场次').toBe('')
})

test('硬护栏：同一副牌在分析开/关两种设置下，结束分数与动作数完全一致', async ({ page }) => {
  // 同一个浏览器上下文里跑两次：第一次关分析（干净的分析区），第二次开分析（写进同一个库）。
  // 两次都固定牌墙与随机流，所以"对局侧的量"必须逐位相等 —— 记录层只许旁路观测（§10.1、§9 硬护栏）。
  const off = await runProbe(page, `?analysis=0&seed=${SEED}`)
  const on = await runProbe(page, `?analysis=1&seed=${SEED}`)

  console.log(`[analysis-lotus-legacy] 开/关对比：分数 off=${off.finalScores} on=${on.finalScores}；`
    + `动作 off=${JSON.stringify(off.gameEvents)} on=${JSON.stringify(on.gameEvents)}；`
    + `随机流抽取 off=${off.rngDraws} on=${on.rngDraws}`)

  // 先证明"比的是同一副牌"：两次消耗的随机流抽取次数必须相同。
  // 不等就说明有别的代码在玩牌期间抽了随机数（比如此前分析侧的某个 defaultId 落到了 Math.random），
  // 那样下面两条断言的失败是假警报 —— 这条会先把真正的原因指出来。
  expect(on.rngDraws, '开/关两次必须消耗同样的随机流（否则比的是两副不同的牌）').toBe(off.rngDraws)
  expect(on.finalScores, '开关不得改变结束分数').toEqual(off.finalScores)
  expect(on.gameEvents, '开关不得改变动作数').toEqual(off.gameEvents)
  expect(on.roundsPlayed).toBe(off.roundsPlayed)
  expect(on.replayRounds, '开关不得改变展示回放的局数').toBe(off.replayRounds)
  // 顺带确认"开"的那一次真的录到了（否则这条护栏是空转通过的）
  expect(on.partsByTag.decision, '开着分析的那一次必须真的录到决策').toBeGreaterThan(0)
  expect(off.storageBlocks, '关着的那一次不写').toBe(0)
})