import { expect, test } from '@playwright/test'

test.setTimeout(120_000)
test('seat rotation keeps the absolute winner and source in the public ledger', async ({ page }) => {
  for (const viewer of [0, 1, 2, 3]) {
    await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=4&viewer=${viewer}`)
    await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
    const badge = page.locator('[data-pile-seat="2"]')
    await expect(badge.locator('..').locator('.avatar')).toHaveAttribute('alt', '西家头像')
    await badge.click()
    await expect(page.locator('.ledger-win')).toHaveCount(4)
    await expect(page.locator('.ledger-win').first()).toContainText('西家 · 第4次胡')
    await expect(page.locator('.ledger-win').first()).toContainText('自摸')
  }
})
for (const [width, height] of [[568, 320], [1280, 720]]) {
  test(`four pile capacities and public ledger at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    for (const count of [0, 1, 4, 12, 40, 80]) {
      await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=${count}`)
      await expect(page.locator('.blood-flow-pile-badge')).toHaveCount(4)
      await expect(page.locator('.blood-flow-pile-badge').first()).toContainText(`胡 ${count}次`)
      await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
      const rectangles = await page.locator('.blood-flow-pile-badge').evaluateAll(elements => elements.map(e => {
        const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }
      }))
      for (const box of rectangles) {
        expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width)
        expect(box.top).toBeGreaterThanOrEqual(0); expect(box.bottom).toBeLessThanOrEqual(height)
      }
      const blockers = await page.locator('.action-bar button, .hand-tile-slot, .blood-flow-preview').evaluateAll(elements => elements.map(e => {
        const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }
      }))
      for (const box of blockers) {
        expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width)
        for (const badge of rectangles) expect(badge.left < box.right && badge.right > box.left && badge.top < box.bottom && badge.bottom > box.top).toBe(false)
      }
      if (count === 80) {
        await page.screenshot({ path: `test-results/blood-flow-piles-${width}.png` })
        await page.locator('[data-pile-seat="2"]').click()
        await expect(page.getByRole('dialog', { name: '血流公开流水' })).toBeVisible()
        await expect(page.locator('.ledger-win')).toHaveCount(80)
        await expect(page.locator('.ledger-win').first()).toContainText('西家 · 第80次胡')
        await page.getByRole('button', { name: '关闭流水' }).click()
      }
    }
    expect(errors).toEqual([])
  })
}
