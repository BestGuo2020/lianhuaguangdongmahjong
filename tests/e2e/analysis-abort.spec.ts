import { expect, test } from '@playwright/test'

// 中途退出的分析记录行为（§9.2、§9.5），用真实引擎 + 真实分析区在浏览器里跑：
// ① 退出时已录到的数据必须刷进分析区并标成「部分缺失 + match-aborted」，不能静默丢；
// ② 本场会话必须随之结束，否则下一场会被 App 的 active() 守卫跳过、记录挂到上一场名下。
test.setTimeout(240_000)

interface AbortStatus {
  ready: boolean
  error: string | null
  errors: string[]
  first: { matchId: string; status: string; parts: number; gapReasons: string[]; blocks: number } | null
  second: { matchId: string; status: string; parts: number; blocks: number } | null
  activeAfterAbort: boolean | null
  activeAfterSecondStart: boolean | null
  startedSecondMatch: boolean
  windowsBeforeAbort: number
  analysisUnavailable: boolean
}

test('中途退出：已录数据刷盘并标为部分缺失，且下一场不会挂到上一场名下（§9.2、§9.5）', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/tests/e2e/fixtures/analysis-abort.html')
  await expect(page.locator('body')).toHaveCount(1)
  await page.waitForFunction(() => {
    const probe = (window as unknown as { __analysisAbort?: AbortStatus }).__analysisAbort
    return Boolean(probe?.ready || probe?.error)
  }, undefined, { timeout: 180_000 })
  const probe = await page.evaluate(() => (window as unknown as { __analysisAbort: AbortStatus }).__analysisAbort)

  expect(probe.error, `夹具自身出错：${probe.error}`).toBeNull()
  expect(pageErrors).toEqual([])
  expect(probe.errors, `录制报错：${probe.errors.join(' | ')}`).toEqual([])
  expect(probe.analysisUnavailable, '分析区应当可用').toBe(false)
  console.log(`[abort] 退出前窗口 ${probe.windowsBeforeAbort} 个；第一场 ${probe.first?.parts} 条/${probe.first?.status}`
    + `；第二场 ${probe.second?.parts} 条/${probe.second?.status}；activeAfterAbort=${probe.activeAfterAbort}`)

  expect(probe.windowsBeforeAbort, '退出前应已经打过若干窗口').toBeGreaterThanOrEqual(8)

  // ① 已录数据不丢 + 如实标不完整
  const first = probe.first!
  expect(first.parts, '中途退出时已录到的记录必须刷进分析区').toBeGreaterThan(0)
  expect(first.status, '中途退出必须标成「部分缺失」，不能报完整').toBe('partial')
  expect(first.gapReasons, '要留下"场次中断"的缺失原因').toContain('match-aborted')

  // ② 会话结束 ⇒ 第二场用新的 matchId 落库（回归：此前会挂到第一场名下）
  expect(probe.activeAfterAbort, '代理 finish 之后会话不应还是 active').toBe(false)
  expect(probe.startedSecondMatch, '第二场必须是新的场次 id').toBe(true)
  expect(probe.activeAfterSecondStart).toBe(true)
  const second = probe.second!
  expect(second.matchId).not.toBe(first.matchId)
  expect(second.parts, '第二场的记录必须落在它自己名下').toBeGreaterThan(0)
  expect(second.gapReasons ?? [], '第二场没有中断标记（它没有走退出路径）').not.toContain('match-aborted')
})
