import { expect, test } from '@playwright/test'

// 玩家自摸窗口改张提示：只在自摸窗口出现，抢杠/点炮窗口零提示。
async function reachSelfDrawWin(page: import('@playwright/test').Page) {
  await page.goto('/tests/e2e/fixtures/blood-flow-claims.html?reform=1')
  // 上家打 m5 后，改张手牌先面对碰/杠/吃/过响应窗口；先过，随后摸到精牌进入自摸窗口。
  const pass = page.locator('.action-bar').getByRole('button', { name: '过', exact: true })
  await expect(pass).toBeVisible({ timeout: 30_000 })
  await pass.click()
}

test('self-draw win window shows the reform hint and marks the suggested discard', async ({ page }) => {
  await reachSelfDrawWin(page)
  const hu = page.locator('.action-bar').getByRole('button', { name: '胡', exact: true })
  await expect(hu).toBeVisible({ timeout: 30_000 })
  // 改张提示由听口工作线程异步计算，等待其出现。
  const tip = page.locator('.blood-flow-reform-tip[data-reform-hint="1"]')
  await expect(tip).toBeVisible({ timeout: 30_000 })
  await expect(tip).toContainText('改张')
  await expect(tip).toContainText('任意听')
  // 建议打出的那张（s7）带改张徽标，且胡按钮仍然完整可用。
  await expect(page.locator('.hand-tile-slot.reform-discard .reform-badge')).toBeVisible()
  await expect(hu).toBeVisible()
})

test('compact viewport keeps the reform tip readable without hiding the win button', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 })
  await reachSelfDrawWin(page)
  const hu = page.locator('.action-bar').getByRole('button', { name: '胡', exact: true })
  await expect(hu).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.blood-flow-reform-tip[data-reform-hint="1"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.hand-tile-slot.reform-discard .reform-badge')).toBeVisible()
})

test('robbed-kong and discard win windows never show the reform hint', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/blood-flow-claims.html')
  const hu = page.locator('.action-bar').getByRole('button', { name: '胡', exact: true })
  await expect(hu).toBeVisible({ timeout: 30_000 })
  // 该夹具的首次响应窗口为点炮/碰杠类窗口：改张提示必须为零。
  await page.waitForTimeout(600)
  await expect(page.locator('.blood-flow-reform-tip')).toHaveCount(0)
})
