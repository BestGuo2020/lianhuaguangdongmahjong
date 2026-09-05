import { expect, test } from '@playwright/test'

test.setTimeout(120_000)
for (const theme of ['jade', 'rosewood', 'happyMahjong', 'llm', 'llmAnime']) {
  test(`${theme}: one central cue, repeated wins coalesce and restore never replays`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=0&theme=${theme}`)
    await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
    await page.evaluate(() => (window as any).__appendBloodFlowWin())
    await expect(page.locator('.blood-flow-central')).toHaveCount(1)
    await expect(page.locator('.blood-flow-central')).toContainText('绿一色')
    await expect(page.locator('.table-action-cue.win')).toHaveCount(0)
    await page.evaluate(() => { for (let i = 0; i < 9; i++) (window as any).__appendBloodFlowWin() })
    await expect(page.locator('[data-pile-seat="0"]')).toContainText('胡 10次')
    await expect(page.locator('.blood-flow-central')).toHaveCount(1)
    await page.screenshot({ path: `test-results/blood-flow-effect-${theme}.png` })
    await page.evaluate(() => (window as any).__restoreBloodFlow())
    await expect(page.locator('.blood-flow-central')).toHaveCount(0)
    await expect(page.locator('[data-pile-seat="0"]')).toContainText('胡 10次')
  })
}
