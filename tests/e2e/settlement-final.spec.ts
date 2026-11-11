import { expect, test } from '@playwright/test'
import { TABLE_THEME_OPTIONS } from '../../src/theme/themeIdentity'

for (const remote of [false, true]) {
  test(`末局结算和终榜可往返（${remote ? '联机翻精' : '单机经典'}）`, async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await page.goto(`/tests/e2e/fixtures/settlement-final.html${remote ? '?remote' : ''}`)
    const round = page.getByRole('dialog', { name: /东4局/ })
    const ranking = page.getByRole('dialog', { name: '最终排名', exact: true })
    await expect(round).toBeVisible()
    await expect(ranking).toHaveCount(0)
    await round.getByRole('button', { name: '查看牌桌' }).click()
    await expect(round).toBeHidden()
    if (remote) await page.evaluate(() => (window as unknown as { finishSettlementFixture(): void }).finishSettlementFixture())
    await expect(ranking).toHaveCount(0)
    await page.getByRole('button', { name: '查看结算', exact: true }).click()
    await round.getByRole('button', { name: '查看最终排名' }).click()
    await expect(ranking).toBeVisible()
    await expect(ranking.locator('.final-rankings article')).toHaveCount(4)
    await expect(ranking.getByRole('button', { name: '返回大厅' })).toBeInViewport({ ratio: 1 })
    await ranking.getByRole('button', { name: '查看本局结算' }).click()
    await expect(round).toContainText(remote ? '平胡' : '中马')
    await expect(round.locator('.player-line').filter({ hasText: '玩家1' }).locator('.mark.dealer')).toBeVisible()
    if (!remote) await expect(round.locator('.horse-hit')).toHaveCount(1)
    await expect(ranking).toHaveCount(0)
  })
}

for (const { value: theme, label } of TABLE_THEME_OPTIONS) {
  test(`${label}的终榜按钮样式一致`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixtures/settlement-final.html?theme=${theme}`)
    await page.getByRole('button', { name: '查看最终排名', exact: true }).click()
    const ranking = page.getByRole('dialog', { name: '最终排名', exact: true })
    const review = ranking.getByRole('button', { name: '查看本局结算', exact: true })
    const lobby = ranking.getByRole('button', { name: '返回大厅', exact: true })
    for (const viewport of [{ width: 1280, height: 720 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport)
      await expect(review).toBeInViewport({ ratio: 1 })
      await expect(lobby).toBeInViewport({ ratio: 1 })
      const [reviewStyle, lobbyStyle] = await ranking.locator('.final-footer > button').evaluateAll(buttons => buttons.map(button => {
        const { background, border, borderRadius, boxShadow, color, fontWeight, height, width } = getComputedStyle(button)
        return { background, border, borderRadius, boxShadow, color, fontWeight, height, width }
      }))
      expect(reviewStyle).toEqual(lobbyStyle)
    }
  })
}
