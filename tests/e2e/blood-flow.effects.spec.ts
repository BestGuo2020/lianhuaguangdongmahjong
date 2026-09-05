import { expect, test } from '@playwright/test'

test.setTimeout(120_000)
for (const theme of ['jade', 'rosewood', 'happyMahjong', 'llm', 'llmAnime']) {
  test(`${theme}: one central cue, repeated wins coalesce and restore never replays`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=0&theme=${theme}`)
    await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
    await page.evaluate(() => (window as any).__appendBloodFlowWin())
    await expect(page.locator('.blood-flow-central')).toHaveCount(1)
    await expect(page.locator('.blood-flow-central')).toContainText('绿一色')
    await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-blood-flow-effects', '1')
    const cue=page.locator('.blood-flow-cue'),canvas=page.locator('canvas.mahjong-scene')
    await expect(canvas).toHaveAttribute('data-blood-flow-cue',(await cue.getAttribute('data-cue-id'))!)
    await expect(canvas).toHaveAttribute('data-blood-flow-cue-start',(await cue.getAttribute('data-cue-start'))!)
    if(theme==='llmAnime')await expect(page.locator('.blood-flow-presentation .anime-action-cue')).toHaveCount(1)
    await expect(page.locator('.table-action-cue.win')).toHaveCount(0)
    await page.evaluate(() => { for (let i = 0; i < 12; i++) (window as any).__appendBloodFlowWin() })
    await expect(page.locator('[data-pile-seat="0"]')).toContainText('胡 13次')
    await expect(page.locator('[data-pile-seat="0"]')).toContainText('4层')
    await expect(page.locator('[data-pile-seat="0"]')).not.toContainText('收纳')
    await expect(page.locator('.blood-flow-central')).toHaveCount(1)
    await page.waitForTimeout(350) // Capture the reused beam/particles after their entrance fade.
    await page.screenshot({ path: `test-results/blood-flow-effect-${theme}.png` })
    await page.evaluate(() => (window as any).__restoreBloodFlow())
    await expect(page.locator('.blood-flow-central')).toHaveCount(0)
    await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-blood-flow-effects', '0')
    await expect(page.locator('[data-pile-seat="0"]')).toContainText('胡 13次')
  })
}
test('three winners have separate 3D effects that survive subsequent table rebuilds and expire', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=12&theme=jade')
  await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-blood-flow-effects', '0')
  await page.evaluate(() => (window as any).__appendBloodFlowMultiWin())
  await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-blood-flow-effects', '3')
  await page.evaluate(() => (window as any).__appendBloodFlowWin()) // forces the ordinary tile mesh rebuild
  await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-blood-flow-effects', '3')
  await page.waitForTimeout(350)
  await page.screenshot({ path: 'test-results/blood-flow-three-win-effects.png' })
  await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-blood-flow-effects', '0', { timeout: 6000 })
})
test('effect resource failure leaves the table usable and the next effect can recover', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=0')
  await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext
    ;(window as any).__restoreCanvasContext = () => { HTMLCanvasElement.prototype.getContext = original }
    HTMLCanvasElement.prototype.getContext = function(type: string, ...args: any[]) {
      return type === '2d' ? null : (original as any).call(this, type, ...args)
    } as typeof original
    ;(window as any).__appendBloodFlowWin()
  })
  await expect(page.locator('.blood-flow-central')).toHaveCount(1)
  await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-blood-flow-effects', '0')
  await page.evaluate(() => { (window as any).__restoreCanvasContext(); (window as any).__appendBloodFlowWin() })
  await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-blood-flow-effects', '1')
  expect(errors).toEqual([])
})
