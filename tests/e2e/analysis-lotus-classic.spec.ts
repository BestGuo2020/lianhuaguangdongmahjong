import { expect, test } from '@playwright/test'

// 莲花广麻 P0 分析记录（约定 §9 的 DoD）。
//
// 探针走真实 useGame + 真实分析区（IndexedDB），把三条判据一次跑完：
//   ① 开关打开跑完整场 → 从**分析库**读回 → parts 形状、行内状态「分析：完整」、
//      导出包自包含（记录 + 被引用配置 + 展示回放）；
//   ② 开关关掉 → 零写入（库里不多一场、块数为 0）；
//   ③ 开/关两种设置下同一场（同一随机序列）的**结束分数与动作数完全一致**（硬护栏）。
//
// 不经由 App.vue：App 里那一行 `analysis: analysis.port` 属于冻结清单，由协调者的
// 「公共改动」提交补上（见 docs/blood-flow/design/analysis-lotus-classic.md）。
// 因此"列表行文案"用真实的 analysisAreaLabel 在数据层判定，等价于 UI 上那一行。
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