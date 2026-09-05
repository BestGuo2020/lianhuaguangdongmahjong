import { expect, test } from '@playwright/test'

test.setTimeout(90_000)
for (const [width, height] of [[1280,720],[568,320]]) {
  test.describe(`${width}x${height} input surface`, () => {
  test.use({ viewport: { width, height }, hasTouch: width < 900 })
  test(`blood-flow preserves the ordinary final-tile gap for every meld count at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    for (const count of [14,11,8,5,2]) {
      let legacyGap = 0
      for (const variant of ['legacy','blood']) {
        await page.goto(`/tests/e2e/fixtures/common-hand-gap.html?count=${count}&variant=${variant}`)
        await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
        await expect(page.locator('.hand-tile-slot')).toHaveCount(count)
        await expect(page.locator('.hand-tile-slot.drawn')).toHaveCount(1)
        await expect(page.locator('.hand-tile-slot').last()).toHaveClass(/drawn/)
        const layout = await page.locator('.hand-tile-slot').evaluateAll(elements => {
          const boxes = elements.map(e => e.getBoundingClientRect())
          return { gap: boxes.at(-1)!.left - boxes.at(-2)!.right,
            margin: parseFloat(getComputedStyle(elements.at(-1)!).marginLeft) }
        })
        expect(layout.margin).toBeGreaterThanOrEqual(8)
        expect(layout.gap).toBeGreaterThanOrEqual(layout.margin)
        if (variant === 'legacy') legacyGap = layout.margin
        else {
          expect(layout.margin).toBe(legacyGap)
          await expect(page.locator('.hand-tile-slot.drawn .mahjong-tile')).toHaveAttribute('aria-label', '一万')
          if (count === 14 || count === 5) await page.screenshot({ path: `test-results/blood-flow-common-gap-${width}-${count}.png` })
        }
      }
    }
    await page.goto('/tests/e2e/fixtures/common-hand-gap.html?count=14&revealed=1')
    await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('.hand-tile-slot')).toHaveCount(14)
    await expect(page.locator('.hand-tile-slot.drawn')).toHaveCount(0)
  })
  })
}
