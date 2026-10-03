import { expect, test } from '@playwright/test'

test.setTimeout(120_000)

test('chicken kong receipts show their scoring kind while win effects remain chicken', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=0')
  await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
  await page.evaluate(async () => { await (window as any).__playBloodFlowScenario('discard', 1, [0], ['chicken'], false) })
  await expect(page.locator('.blood-flow-central')).toContainText('鸡胡')
  await expect(page.locator('.blood-flow-cue')).toHaveCount(0, { timeout: 10_000 })
  for (const [kind, label, counts, weight] of [
    ['discard', '明杠', { exposed: 1, concealed: 0, wind: 0 }, 1],
    ['concealed', '暗杠', { exposed: 1, concealed: 1, wind: 0 }, 2],
    ['wind', '风杠', { exposed: 1, concealed: 1, wind: 1 }, 1],
  ] as const) {
    await page.evaluate(kind => (window as any).__appendBloodFlowKong(0, kind), kind)
    await expect(page.locator('.blood-flow-cue')).toHaveCount(1)
    await expect(page.locator('.blood-flow-cue')).toHaveCount(0, { timeout: 10_000 })
    await page.evaluate(async counts => { await (window as any).__playBloodFlowScenario('discard', 1, [0], ['chicken'], false, counts) }, counts)
    await expect(page.locator('.blood-flow-central')).toContainText('鸡胡')
    await expect(page.locator('.blood-flow-cue')).toHaveCount(0, { timeout: 10_000 })
    await page.locator('[data-pile-seat="0"]').click()
    const cards = page.locator('.blood-flow-win-card')
    await expect(cards.first()).toContainText(`${label}+${weight}`)
    await expect(cards.first()).not.toContainText('鸡胡')
    await expect(cards.last()).toContainText('鸡胡+0.5')
    await expect(cards.last()).not.toContainText('明杠')
    await page.getByRole('button', { name: '关闭流水' }).click()
  }
  await page.evaluate(() => (window as any).__settleBloodFlow(false))
  await expect(page.getByRole('dialog', { name: '血流本局结算' })).toBeVisible()
  await page.getByRole('dialog', { name: '血流本局结算' }).getByRole('button', { name: '查看流水', exact: true }).click()
  await expect(page.locator('.blood-flow-win-card').first()).toContainText('明杠+1')
  await expect(page.locator('.blood-flow-win-card').first()).toContainText('暗杠+2')
  await expect(page.locator('.blood-flow-win-card').first()).toContainText('风杠+1')
  await expect(page.locator('.blood-flow-win-card').first()).not.toContainText('鸡胡')
  await page.screenshot({ path: 'test-results/blood-flow-kong-score-card.png' })
})
