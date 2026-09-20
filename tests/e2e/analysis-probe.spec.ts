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

interface ProbeStatus {
  ready: boolean
  error: string | null
  errors: string[]
  rounds: ProbeRound[]
  windowTrace: string[]
  callTrace: string[]
  timings: { playMs: number; replayMs: number }
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
  }
})
