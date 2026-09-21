import { expect, test } from '@playwright/test'

// 「莲花麻将·翻精癞子」分析记录的端到端（约定 §9 的 P0 + P1）：
// ① 真实引擎 + 真实分析区跑完一场 ⇒ 从 IndexedDB 读回，断言记录形状（config/decisionState/decision/settlement/reproduction）、
//    前态与决策一一对应、窗口 ID 唯一、结算四家变化之和为 0、行内状态「分析：完整」（读的是同一份落库状态）；
// ② 导出包自包含（记录 + 被引用配置 + 展示回放），且**按记录内容**如实声称"可精确复现"（P1 §2.4）；
// ③ 开关关掉后**零写入**（含复现数据）；
// ④ 硬护栏：同一副牌（固定牌墙 + 固定随机流）在"分析开/关"两种设置下，结束分数与动作数完全一致；
// ⑤ P1：把落库读回的复现数据逐局重跑 ⇒ 到达同一结束状态（含发牌后手牌交叉校验），
//    以及"把记录改一张 ⇒ 报不一致并停下"的负向对照。
//
// 为什么走夹具而不是真实 App：`src/App.vue` 在协调者的冻结清单里（约定 §3），给 `useLotusGame` 传
// `analysis: analysis.port` 的那一行由协调者走「公共改动」提交。夹具按与 App 同一套接线直接挂载引擎，
// 记录链路完全同源；差的只是"大厅列表行内状态"那一层 UI —— 用例里断言的是它读的那个落库状态。
//
// 查询参数：`?analysis=0|1`（开关记录）、`?seed=N`（固定牌墙与随机流）、`?llm=1`（接通 LLM 座位的接缝）、
// `?replay=0`（跳过 P1 的逐局重跑 —— 与复现无关的用例不必付这份时间）。
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
  llmParts: number
  promptTemplateParts: number
  attemptUserSample: string | null
  sentUserSample: string | null
  decisionSources: string[]
  attemptDecisionsWithoutModelSource: number
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
  const probe = await runProbe(page, `?analysis=1&seed=${SEED}&replay=0`)

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
  // P1（§2.1）：复现数据也必须落库，且**每一局一条**（打了 N 局就有 N 条可重跑的起点）
  expect(probe.partsByTag.reproduction, '每一局都要落一条复现数据').toBe(probe.roundsPlayed)
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
  // P1 之后这一场带着**内容完整**的复现数据 ⇒ 导出包必须如实声称"可以精确复现"（§2.4）。
  // 判据不再是"有没有 reproduction 记录"，而是逐局看字段齐不齐（`reproductionCapability.ts`）。
  expect(probe.reproductionCapable, 'P1 起复现数据字段齐全 ⇒ 应当声称可精确复现').toBe(true)
  expect(manifest!.missing, '可精确复现时不该再有任何缺失项').toEqual([])
})

test('P1 赛后复现：从落库读回的复现数据逐局重跑 ⇒ 到达同一结束状态（§2、§4 的 DoD）', async ({ page }) => {
  // 这条是 P1 的核心验收点：**不是**读字段对不对，而是拿记录里的"环状牌墙 + 两颗骰子 + 庄家 + 当局开局分
  // + 权威动作序列"重新跑一局，看能不能到达同一个结束状态（§2.3：不许拿"跑通"当"复现"）。
  //
  // 为什么必须在浏览器里跑：校验器要起真实 `useLotusGame`（Vue 响应式 + 定时器链），
  // vitest 环境里没有这套 DOM/定时器组合（§3.5）。
  test.setTimeout(900_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const probe = await runProbe(page, `?analysis=1&seed=${SEED}`)

  expect(pageErrors, `页面报错：${pageErrors.join(' | ')}`).toEqual([])
  expect(probe.roundsPlayed, '应当打完东风场').toBeGreaterThanOrEqual(4)
  console.log(`[analysis-lotus-legacy] P1 重跑：复现数据 ${probe.reproductionParts} 条；`
    + `逐局 ${probe.reproductionRounds.map((run) => `#${run.roundIndex} ok=${run.ok} 命令 ${run.commandsConsumed}/${run.commandsRecorded}`
      + ` 窗口 ${run.windowsOpened} 分数 ${run.finalScores.join('/')}`).join(' | ')}；`
    + `篡改对照 ok=${probe.postDealTamper?.ok} 命令 ${probe.postDealTamper?.commandsConsumed}`)

  // 复现数据逐局落库（跳过的局会在 `partsByTag.reproduction` 上少一条，前面那条用例已经卡住了这一点）
  expect(probe.reproductionParts, '每一局都要有复现数据').toBe(probe.roundsPlayed)
  expect(probe.reproductionRounds, '每一局都要真的重跑一次').toHaveLength(probe.reproductionParts)

  for (const run of probe.reproductionRounds) {
    const where = `第 ${run.roundIndex} 局`
    expect(run.ok, `${where}重跑未到达同一结束状态：${run.reason ?? '（没有给出原因，这本身就是缺陷）'}`).toBe(true)
    // ① 发牌后的手牌必须**交叉校验过**并且一致（§3.3）：这一步不一致就说明"发牌算法变了或记录与引擎不一致"
    expect(run.postDealChecked, `${where}必须做发牌后手牌的交叉校验（没做就等于没验证）`).toBe(true)
    expect(run.postDealOk, `${where}发牌后的手牌必须与记录一致`).toBe(true)
    // ② 翻精/精牌/开牌断点由牌墙+骰子推出，重跑推出来的必须与记录一致
    expect(run.openingChecked, `${where}必须校验翻精与开牌断点`).toBe(true)
    expect(run.openingOk, `${where}翻精/精牌/开牌断点必须与记录一致`).toBe(true)
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
    // ② 每条命令在记录时都确实落在当时的合法动作里（P0 的 chosenIndex ≥ 0 ⇒ 带 legalActionId）。
    expect(run.nonCommandEntries, `${where}命令日志里不该有非命令口径的条目`).toBe(0)
    expect(run.commandsNotLegalAtRecordTime, `${where}每条命令在记录时都必须是合法动作（不许把被拒动作记进来）`).toBe(0)
    expect(run.kindMismatches, `${where}窗口类型必须逐窗口对上`).toBe(0)
    expect(run.gaps, `${where}重跑期间不得留缝：${run.gaps.join(' | ')}`).toEqual([])
  }
  // 一局至少一手牌，所以整场命令数必然多于局数 —— 顺带证明记的不是"每局一条"那种空壳
  expect(probe.reproductionRounds.reduce((total, run) => total + run.commandsRecorded, 0))
    .toBeGreaterThan(probe.roundsPlayed)

  // ── 负向对照（§3.3、§4）：把记录改一张 ⇒ 必须报"发牌算法变了或记录与引擎不一致"并**停下来** ──
  const tamper = probe.postDealTamper
  expect(tamper, '夹具应当做"改了记录"的负向对照').not.toBeNull()
  expect(tamper!.ok, '记录被动过就不能再声称复现成功').toBe(false)
  expect(tamper!.reason, '失败原因必须点明是发牌/记录与引擎不一致').toContain('发牌算法变了或记录与引擎不一致')
  expect(tamper!.commandsConsumed, '发现不一致之后不许再喂任何命令（更不许跳过它把这一局跑完）').toBe(0)
})

test('翻精癞子：分析开关关掉后零写入', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const probe = await runProbe(page, `?analysis=0&seed=${SEED}&replay=0`)

  expect(pageErrors).toEqual([])
  expect(probe.analysisEnabled).toBe(false)
  expect(probe.roundsPlayed, '关掉分析也要能把整场打完').toBeGreaterThanOrEqual(4)
  expect(probe.storageAvailable, '分析区仍然可用 —— 所以下面的 0 是"没写"而不是"写不进去"').toBe(true)
  // 关掉分析 ⇒ 一条记录都不产生（§9.2、§10.7：关闭时零成本、零写入）
  expect(probe.storageBlocks, '关掉分析后不得有任何分析块').toBe(0)
  expect(probe.storageMatches, '关掉分析后不得有场次元数据').toBe(0)
  expect(Object.keys(probe.partsByTag), '关掉分析后不得有任何记录').toEqual([])
  // P1：复现数据也必须在关掉时为零 —— 它同样是"旁路记录"，不许在关掉时还去抓牌墙/命令（§10.7）
  expect(probe.reproductionParts, '关掉分析后不得有复现数据').toBe(0)
  expect(probe.matchId, '关掉分析时不开场次').toBe('')
})

test('硬护栏：同一副牌在分析开/关两种设置下，结束分数与动作数完全一致', async ({ page }) => {
  // 同一个浏览器上下文里跑两次：第一次关分析（干净的分析区），第二次开分析（写进同一个库）。
  // 两次都固定牌墙与随机流，所以"对局侧的量"必须逐位相等 —— 记录层只许旁路观测（§10.1、§9 硬护栏）。
  const off = await runProbe(page, `?analysis=0&seed=${SEED}&replay=0`)
  const on = await runProbe(page, `?analysis=1&seed=${SEED}&replay=0`)

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

test('LLM 座位：真实 LLM 控制器走接缝 ⇒ llm 记录、模板去重、落库变量与发给模型的逐字相等', async ({ page }) => {
  // 这条覆盖的是**接线**：`useLotusGame({ analysisSink })` 必须在模型请求发生的那一刻
  // 告诉接缝"该座位在飞的是哪个窗口"（钩子只带 seat 过来）。单测里 `windowOpened` 是手工调的，
  // 抓不到这里的顺序错、座位错或窗口早关。
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const probe = await runProbe(page, `?analysis=1&llm=1&seed=${SEED}&replay=0`)

  expect(pageErrors, `页面报错：${pageErrors.join(' | ')}`).toEqual([])
  expect(probe.storageAvailable).toBe(true)
  expect(probe.roundsPlayed, '应当打完东风场').toBeGreaterThanOrEqual(4)
  expect(probe.storedStatus, '这一场仍应落成完整').toBe('complete')
  console.log(`[analysis-lotus-legacy] LLM 座位：尝试 ${probe.llmParts} 条、模板 ${probe.promptTemplateParts} 条；`
    + `来源 ${JSON.stringify(probe.decisionSources)}`)

  // 真的发出过请求、也真的落了尝试（座位 1 的 LLM 控制器会打很多手）
  expect(probe.llmParts, 'LLM 座位应当留下尝试记录').toBeGreaterThan(0)
  // 来源必须归因到模型侧（§9 的 DoD：接钩子后改为 model / model-fallback）。
  // **判据落在"有请求的那些决策"上**，而不是"LLM 座位一条 unknown 都不许有"：
  // LLM 控制器在"必成杠上开花 / 已成和 / 无选项"这些分支上会短路成本地逻辑、根本不发请求
  // （文档 §6 有对照表），那些窗口没有 llm 记录、来源也不是 model —— 此时 `unknown` 是如实的。
  expect(probe.attemptDecisionsWithoutModelSource, '发过请求的决策必须归因到 model / model-fallback').toBe(0)
  expect(probe.decisionSources.some((source) => source === 'model' || source === 'model-fallback')).toBe(true)
  // 模板按 id 只存一次（打桩模型固定回同一个模板）
  expect(probe.promptTemplateParts, '提示词模板必须按 id 去重只存一条').toBe(1)
  // 落库的 user 与真正发给模型的 user 逐字相等（A 证明钩子↔请求体，这里证明钩子↔落库）
  expect(probe.attemptUserSample, '落库尝试里应当有 user 变量').toBeTruthy()
  expect(probe.attemptUserSample).toBe(probe.sentUserSample)
})

test('app-path：走真实 App 打完一场东风场，从分析库读回翻精癞子的记录', async ({ page }) => {
  // 约定 §9 的必做项（2026-09-21 追加）：这条锁的是**协调者在 `App.vue` 里补的端口传递那一行**
  // （`useLotusGame({ analysis: analysis.port })`）—— 引擎级夹具用例注入的是自己的 recorder，
  // 证明不了那一行。
  //
  // 三个坑（约定 §9.1）都按这里的做法绕开了：
  // ① 缓冲写 ⇒ 必须走到 flush 点。单机没有「返回大厅」可点（它只在结算的**最终排名**里），
  //    所以这里**把整场打完** —— 整场结束时 App 的 `matchFinished` 会调 `analysis.finish()` 刷盘。
  // ② 托管按钮单机没有 ⇒ 不用它。
  // ③ 手牌是 pointer 手势 ⇒ 点内层 `.mahjong-tile`（不是外层 `.hand-tile-slot`）。
  test.setTimeout(660_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  // 节奏压缩：把页面里所有定时器压到 ≤250ms。整场东风场在真实节奏下要 **7 分钟**（实测），
  // 而这条用例要锁的是"App 的端口传递那一行有没有生效"，不是真实配速 —— 压缩后同样走
  // 真实 App、真实引擎、真实 UI 交互（点内层牌元素、点「继续」），只是不等演出。
  //
  // **下限不能压到 10ms**（2026-09-22 实测修正，这条用例此前在本机一直红）：
  // 牌桌初始化要预加载 34 张牌面，`tileAssets.ts` 用 `window.setTimeout(..., FETCH_TIMEOUT_MS)`
  // 给每个 `fetch` 挂了一个 **12 秒**的中止定时器；压到 10ms 就等于"10ms 内没回就中止"，
  // 于是 34 个请求全被 abort（`net::ERR_ABORTED`）→「牌面资源加载失败」→ 牌桌报
  // 「牌桌资源加载失败」→ `.flip-indicator` 永远不出现。实测：下限 10ms 必红，50/250/1000ms 都绿。
  // 这不是"对局慢"（真实定时器是秒级，250ms 仍是十几倍压缩），而是把**网络超时**一起压缩了。
  await page.addInitScript(() => {
    const realSetTimeout = window.setTimeout.bind(window)
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
      realSetTimeout(handler as never, Math.min(Number(timeout) || 0, 250), ...args)
    )) as typeof window.setTimeout
  })

  await page.goto('/')
  await page.locator('.game-settings button', { hasText: '玩法' }).click()
  await page.getByRole('button', { name: /莲花麻将 翻精/ }).click()
  await page.getByRole('button', { name: '确定' }).click()
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.flip-indicator')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(4)

  const finalButton = page.getByRole('button', { name: '返回大厅' })
  const continueButton = page.getByRole('button', { name: /^继续/ })
  const enabledTiles = page.locator('.hand-tile-slot .mahjong-tile:not(.disabled)')
  const passButton = page.locator('.action-bar').getByRole('button', { name: '过', exact: true })
  let advanced = 0
  const until = Date.now() + 540_000
  while (Date.now() < until) {
    if (await finalButton.count() && await finalButton.isVisible().catch(() => false)) break
    if (await continueButton.count() && await continueButton.isVisible().catch(() => false)) {
      await continueButton.click({ timeout: 5_000 }).catch(() => {})
      advanced += 1
      await page.waitForTimeout(400)
      continue
    }
    if (await passButton.count() && await passButton.isVisible().catch(() => false)) {
      await passButton.click({ timeout: 3_000 }).catch(() => {})
    } else if (await enabledTiles.count()) {
      await enabledTiles.last().click({ timeout: 5_000 }).catch(() => {})
    }
    await page.waitForTimeout(120)
  }
  expect(await finalButton.isVisible().catch(() => false), `整场应当打完（推进了 ${advanced} 局）`).toBe(true)

  // 从分析库读回：整场结束时 App 已调 analysis.finish()，但落库是异步的 ⇒ 轮询（约定 §9.1 坑 1）。
  // **必须解码后按 tag 计数**：只数分块/记录条数是假阳性 —— 没有端口那一行时，
  // App 的 `analysis.start()` 仍会写下**配置**那一条（公共地基的能力表让 `lotus-legacy` 开局），
  // 于是"有分块、rulesetId 也对"全都成立，但一条决策都没有（正是「未记录到任何数据」那状态）。
  const readBack = async () => page.evaluate(async () => {
    const empty = { blocks: 0, partsByTag: {} as Record<string, number>, rulesetIds: [] as string[] }
    const exists = (await indexedDB.databases?.())?.some((entry) => entry.name === 'lianhua-guangma-analysis')
    if (!exists) return empty
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open('lianhua-guangma-analysis')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    if (!db) return empty
    const readAll = <T,>(store: string) => new Promise<T[]>((resolve) => {
      if (!db.objectStoreNames.contains(store)) return resolve([])
      const tx = db.transaction(store, 'readonly')
      const request = tx.objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result as T[])
      request.onerror = () => resolve([])
    })
    const blocks = await readAll<{ sequence: number; codec: string; rawBytes: number; storedBytes: number; checksum: string; parts: number; payload: Uint8Array }>('blocks')
    const matches = await readAll<{ rulesetId?: string }>('matches')
    db.close()
    const { decodeAnalysisBlock } = await import('/src/game/replay/analysis/codec.ts')
    const partsByTag: Record<string, number> = {}
    for (const block of blocks.slice().sort((a, b) => Number(a.sequence) - Number(b.sequence))) {
      const decoded = await decodeAnalysisBlock({
        sequence: Number(block.sequence), codec: block.codec as 'gzip' | 'raw', rawBytes: Number(block.rawBytes),
        storedBytes: Number(block.storedBytes), checksum: String(block.checksum), parts: Number(block.parts),
        payload: new Uint8Array(block.payload),
      })
      for (const part of decoded.parts ?? []) partsByTag[part.tag] = (partsByTag[part.tag] ?? 0) + 1
    }
    return { blocks: blocks.length, partsByTag, rulesetIds: matches.map((entry) => String(entry.rulesetId ?? '')) }
  })
  await expect.poll(async () => (await readBack()).partsByTag.decision ?? 0, {
    timeout: 90_000,
    intervals: [500],
    message: '分析区里始终没有决策记录 —— 若 `App.vue` 还没给 `useLotusGame` 传 `analysis: analysis.port`，'
      + '这条用例必然失败（协调者的待办，见 docs/blood-flow/design/analysis-lotus-legacy.md §10 第 4 条）：'
      + '没有那一行时只有"配置"那一条记录，正是「未记录到任何数据」的状态',
  }).toBeGreaterThan(0)

  const read = await readBack()
  console.log(`[analysis-lotus-legacy] app-path：推进 ${advanced} 局；分块 ${read.blocks}、`
    + `记录 ${JSON.stringify(read.partsByTag)}、rulesetId ${JSON.stringify(read.rulesetIds)}`)
  // 真正锁住"端口那一行生效"的判据：有决策与前态（配置那一条不算）
  expect(read.partsByTag.decision ?? 0, '真实 App 路径必须真的写下决策（根因同上：App.vue 的端口那一行）')
    .toBeGreaterThan(0)
  expect(read.partsByTag.decisionState ?? 0, '真实 App 路径必须真的写下决策前态').toBeGreaterThan(0)
  expect(read.partsByTag.settlement ?? 0, '真实 App 路径必须真的写下结算').toBeGreaterThan(0)
  expect(read.rulesetIds, '场次的玩法 id 必须是 lotus-legacy').toContain('lotus-legacy')
  expect(pageErrors, `页面报错：${pageErrors.join(' | ')}`).toEqual([])
})