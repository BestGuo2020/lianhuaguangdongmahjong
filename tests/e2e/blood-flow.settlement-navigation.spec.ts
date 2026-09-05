import { expect, test } from '@playwright/test'

test.setTimeout(60_000)

test('same-round snapshot does not reopen a settlement closed with X', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=0')
  await page.evaluate(() => (window as any).__settleBloodFlow(false))
  const dialog = page.getByRole('dialog', { name: '血流公开流水' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '关闭流水' }).click()
  await expect(dialog).toHaveCount(0)
  await page.evaluate(() => (window as any).__refreshBloodFlowResult())
  await expect(dialog).toHaveCount(0)
})

for (const { width, height, finished, count } of [
  { width: 1280, height: 720, finished: false, count: 0 },
  { width: 568, height: 320, finished: true, count: 4 },
]) {
  test(`settlement can show the table and reopen after X at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=${count}`)
    await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
    await page.evaluate(finished => (window as any).__settleBloodFlow(finished), finished)
    const dialog = page.getByRole('dialog', { name: '血流公开流水' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '查看牌桌', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('canvas.mahjong-scene')).toBeVisible()
    const reopen = page.getByRole('button', { name: '返回结算', exact: true })
    await expect(reopen).toBeVisible()
    const buttonBox = await reopen.boundingBox()
    expect(buttonBox).not.toBeNull()
    for (const tileBox of await page.locator('.hand-tile-slot').evaluateAll(tiles => tiles.map(tile => {
      const box = tile.getBoundingClientRect()
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom }
    }))) {
      expect(buttonBox!.x < tileBox.right && buttonBox!.x + buttonBox!.width > tileBox.x
        && buttonBox!.y < tileBox.bottom && buttonBox!.y + buttonBox!.height > tileBox.y).toBe(false)
    }
    await page.screenshot({ path: `test-results/blood-flow-table-return-${width}.png` })
    // Receiving the same result again must not undo the player's close action.
    await page.evaluate(() => (window as any).__refreshBloodFlowResult())
    await expect(dialog).toHaveCount(0)
    await reopen.click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '关闭流水' }).click()
    await expect(dialog).toHaveCount(0)
    await page.evaluate(() => (window as any).__refreshBloodFlowResult())
    await expect(dialog).toHaveCount(0)
    await reopen.click()
    await expect(dialog).toBeVisible()
    const before = await page.evaluate(() => (window as any).__bloodFlowNavigation)
    expect(before).toEqual({ nextRoundCalls: 0, returnToLobbyCalls: 0 })
    if (finished) {
      await expect(dialog.getByRole('button', { name: '继续下一局' })).toHaveCount(0)
      await dialog.getByRole('button', { name: '返回大厅' }).click()
      expect(await page.evaluate(() => (window as any).__bloodFlowNavigation.returnToLobbyCalls)).toBe(1)
    } else {
      await dialog.getByRole('button', { name: '继续下一局' }).click()
      expect(await page.evaluate(() => (window as any).__bloodFlowNavigation.nextRoundCalls)).toBe(1)
      await page.evaluate(() => (window as any).__nextBloodFlowFixtureRound())
      await expect(dialog).toHaveCount(0)
      await expect(reopen).toHaveCount(0)
      await page.evaluate(() => (window as any).__settleBloodFlow(false))
      await expect(dialog).toBeVisible()
    }
  })
}

test('closing a filtered ledger restores an explicit whole-round settlement entry', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=2')
  await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
  const dialog = page.getByRole('dialog', { name: '血流公开流水' })
  await page.locator('[data-pile-seat="2"]').click()
  await expect(dialog.locator('.ledger-win')).toHaveCount(2)
  await dialog.getByRole('button', { name: '关闭流水' }).click()
  await expect(page.getByRole('button', { name: '返回结算', exact: true })).toHaveCount(0)
  await page.evaluate(() => (window as any).__settleBloodFlow(false))
  await dialog.getByRole('button', { name: '查看牌桌' }).click()
  await page.locator('[data-pile-seat="2"]').click()
  await expect(dialog.locator('.ledger-win')).toHaveCount(2)
  await dialog.getByRole('button', { name: '关闭流水' }).click()
  await page.getByRole('button', { name: '返回结算', exact: true }).click()
  await expect(dialog.locator('.ledger-win')).toHaveCount(8)
})
