import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// §10.6 的快速测量工具：只跑一场血流并把**完整分析记录 + 权威窗口轨迹 + 逐局回放结果**
// 落到 tmp/analysis-probe.json，供离线逐条比对（比整条 replay.spec 快一个数量级，
// 因此每改一处都可以跑 2~3 次，符合"随机牌局下必须多次复跑"的纪律）。
//
// 这里的断言只做**回归护栏**（记录格式必须自洽）；复现是否成立由 tmp 里的 replayProgress/
// replayReasons 观察，避免"断言一失败就看不到后面的数据"。
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

/** 牌码集合（记录格式统一后的唯一写法）。 */
const CODE_TILES = new Set(['east', 'south', 'west', 'north', 'red', 'green', 'white'])

interface ProbeRound {
  roundIndex: number
  endingScores: number[] | null
  entries: {
    total: number
    resolutions: Record<string, number>
    withoutWindowId: number
    withoutWindowKind: number
    perWindow: Array<{ no: number; kinds: string[]; entries: string[] }>
  }
  replay: { ok: boolean; reason: string | null; submitted: number; recorded: number; kindMismatches: number; scoresMatch: boolean | null; finalScores: number[] } | null
}

/** 容量报告（§9.1、§10.11）：由浏览器侧用真实读数构建。 */
interface CapacityProbe {
  report: {
    rounds: number
    analysis: { parts: number; jsonUtf16Units: number; jsonUtf8Bytes: number; blocks: number; rawBytes: number; storedBytes: number; gzipRatio: number | null; codecs: string[] }
    ledger: { bytes: number; matches: number; perMatchBytes: number }
    metadata: { jsonUtf8Bytes: number | null; idbIndexOverhead: string }
    replay: { bytes: number | null }
    export: { bytes: number | null; ratioToAnalysisStored: number | null }
    browserEstimate: { usage: number; quota: number; note: string } | null
    persistence: string | null
    projections: { fiftyMatchesBytes: number; twoHundredMatchesBytes: number }
  }
  text: string
}

interface ProbeStatus {
  ready: boolean
  error: string | null
  errors: string[]
  rounds: ProbeRound[]
  windowTrace: string[]
  callTrace: string[]
  timings: { playMs: number; replayMs: number }
  mode: 'east' | 'hanchan'
  seed: number | null
  replayBytes: number | null
  capacityReport: unknown | null
  capacityText: string | null
}

test('血流一场：分析记录逐局回放测量（§10.6 快速探针）', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/tests/e2e/fixtures/analysis-probe.html')
  await expect(page.locator('body')).toHaveCount(1)
  await page.waitForFunction(() => {
    const probe = (window as unknown as { __analysisProbe?: ProbeStatus }).__analysisProbe
    return Boolean(probe?.ready || probe?.error)
  }, undefined, { timeout: 240_000 })
  const probe = await page.evaluate(() => (window as unknown as { __analysisProbe: ProbeStatus }).__analysisProbe)
  expect(probe.error, `探针自身出错：${probe.error}`).toBeNull()
  expect(pageErrors).toEqual([])
  expect(probe.errors, `对局/录制错误：${probe.errors.join(' | ')}`).toEqual([])
  expect(probe.rounds.length, '东风场应有 4 局').toBe(4)

  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  await mkdir(`${repoRoot}/tmp`, { recursive: true })
  const outFile = `${repoRoot}/tmp/analysis-probe.json`
  // 先落盘再断言：断言失败时也要留下完整数据
  await writeFile(outFile, JSON.stringify(probe, null, 2))
  console.log(`[analysis-probe] 逐局回放 ${probe.rounds.map(round => `${round.replay?.submitted}/${round.replay?.recorded}${round.replay?.ok ? ' ok' : ''}`).join('  ')}`)
  console.log(`[analysis-probe] 推进来源 ${probe.rounds.map((round, index) => {
    const metrics = round.replay?.metrics
    return `#${index + 1} 应用${metrics?.expireApplied ?? '?'}/编号丢${metrics?.expireSkippedByNumber ?? '?'}/过滤丢${metrics?.expireSkippedByFilter ?? '?'}`
  }).join('  ')}`)
  console.log(`[analysis-probe] 耗时：对局 ${probe.timings.playMs}ms / 回放 ${probe.timings.replayMs}ms；窗口轨迹 ${probe.windowTrace.length} 条`)
  for (const round of probe.rounds) {
    if (!round.replay?.ok) console.log(`[analysis-probe] 第 ${round.roundIndex} 局失败原因：${round.replay?.reason}`)
  }

  for (const round of probe.rounds) {
    // 回归护栏：命令条目必须带窗口归属与窗口类型 —— 缺 windowId 会被校验器排到序列末尾，
    // 缺 windowKind 则无法做两侧同编号窗口的类型对照（§11）。
    expect(round.entries.withoutWindowId, `第 ${round.roundIndex} 局有命令条目缺 windowId`).toBe(0)
    expect(round.entries.withoutWindowKind, `第 ${round.roundIndex} 局有命令条目缺 windowKind`).toBe(0)
    expect(round.replay, `第 ${round.roundIndex} 局应有回放结果`).toBeTruthy()
    if (round.replay!.ok) expect(round.replay!.reason).toBeNull()
    // 记录格式统一：牌一律记牌码（旧记录的中文显示名读取侧仍兼容）
    const wall = (round.record.initialWall ?? []) as string[]
    expect(wall.length).toBeGreaterThan(0)
    expect(wall.every(tile => /^[mps][1-9]$/.test(tile) || CODE_TILES.has(tile)),
      `第 ${round.roundIndex} 局牌墙应记牌码，实际见到：${wall.filter(tile => !/^[mps][1-9]$/.test(tile) && !CODE_TILES.has(tile)).slice(0, 3).join('/')}`).toBe(true)
    const hands = (round.record.initialHands ?? []) as string[][]
    expect(hands.every(hand => hand.every(tile => /^[mps][1-9]$/.test(tile) || CODE_TILES.has(tile)))).toBe(true)
  }
})

// §9.1／§10.11 的容量基线工具：**固定输入**（半庄 8 局 + 固定种子的牌墙），
// 同一份报告里分开列出记录条数、UTF-16 码元数、UTF-8 字节、分块 gzip 字节、应用账本、
// 展示回放、导出包字节与浏览器估算读数（后者标注为同源估算）。
test('容量基线：固定种子半庄 + 分析录制，输出分开记账的容量报告（§9.1、§10.11）', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/tests/e2e/fixtures/analysis-probe.html?mode=hanchan&seed=83')
  await expect(page.locator('body')).toHaveCount(1)
  await page.waitForFunction(() => {
    const probe = (window as unknown as { __analysisProbe?: ProbeStatus }).__analysisProbe
    return Boolean(probe?.ready || probe?.error)
  }, undefined, { timeout: 300_000 })
  const probe = await page.evaluate(() => (window as unknown as { __analysisProbe: ProbeStatus }).__analysisProbe)
  expect(probe.error, `探针自身出错：${probe.error}`).toBeNull()
  expect(pageErrors).toEqual([])
  expect(probe.errors, `对局/录制错误：${probe.errors.join(' | ')}`).toEqual([])
  expect(probe.mode).toBe('hanchan')
  expect(probe.seed).toBe(83)
  expect(probe.rounds.length, '半庄应有 8 局').toBe(8)

  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  await mkdir(`${repoRoot}/tmp`, { recursive: true })
  const outFile = `${repoRoot}/tmp/analysis-capacity.json`
  await writeFile(outFile, JSON.stringify({
    mode: probe.mode, seed: probe.seed, capturedAt: new Date().toISOString(),
    report: probe.capacityReport, text: probe.capacityText, replayBytes: probe.replayBytes,
  }, null, 2))
  console.log(probe.capacityText ?? '（未生成容量报告）')

  const report = probe.capacityReport as {
    rounds: number
    analysis: { parts: number; jsonUtf16Units: number; jsonUtf8Bytes: number; blocks: number; rawBytes: number; storedBytes: number; gzipRatio: number | null; codecs: string[] }
    ledger: { bytes: number; matches: number; perMatchBytes: number }
    metadata: { jsonUtf8Bytes: number | null; idbIndexOverhead: string }
    replay: { bytes: number | null }
    export: { bytes: number | null; ratioToAnalysisStored: number | null }
    browserEstimate: { usage: number; quota: number; note: string } | null
    persistence: string | null
    projections: { fiftyMatchesBytes: number; twoHundredMatchesBytes: number }
  } | null
  expect(report, '探针应产出容量报告').toBeTruthy()
  expect(report!.rounds).toBe(8)
  expect(report!.analysis.parts).toBeGreaterThan(1000)
  expect(report!.analysis.jsonUtf16Units).toBeGreaterThan(0)
  expect(report!.analysis.jsonUtf8Bytes, 'UTF-8 字节与 UTF-16 码元数必须分开报').toBeGreaterThan(0)
  expect(report!.analysis.blocks).toBeGreaterThan(10)
  expect(report!.analysis.codecs).toContain('gzip')
  expect(report!.analysis.gzipRatio, '应有压缩比').toBeGreaterThan(0)
  expect(report!.analysis.storedBytes).toBeLessThan(report!.analysis.rawBytes)
  expect(report!.ledger.matches, '账本应记录本场').toBeGreaterThan(0)
  expect(report!.ledger.perMatchBytes, '半庄单场字节应可推算').toBeGreaterThan(0)
  expect(report!.replay.bytes, '展示回放字节应实测（§9.1 要求分开记账）').toBeGreaterThan(0)
  expect(report!.export.bytes, '导出包字节应实测').toBeGreaterThan(0)
  expect(report!.metadata.idbIndexOverhead).toBe('not-measurable')
  expect(report!.projections.fiftyMatchesBytes).toBeGreaterThan(0)
  expect(probe.capacityText).toContain('线性推算（不是保证）')
  // 复现仍然成立：容量报告不能靠少录内容换来
  for (const round of probe.rounds) {
    expect(round.replay?.reason, `半庄第 ${round.roundIndex} 局应复现成功`).toBeNull()
    expect(round.replay?.submitted).toBe(round.replay?.recorded)
  }
})
