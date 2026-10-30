import { expect, test } from '@playwright/test'

test.setTimeout(60_000)

for (const theme of ['jade', 'rosewood', 'happyMahjong', 'llm', 'llmAnime']) {
  for (const touch of [true, false]) {
    test(`${theme}: compact seats and nickname taps (${touch ? 'touch' : 'fine pointer'})`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 880, height: 405 }, hasTouch: touch, isMobile: touch })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(`http://127.0.0.1:${process.env.E2E_PORT || 4173}/tests/e2e/fixtures/blood-flow.html?count=0&theme=${theme}`)
      await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
      const seats = page.locator('.game-table-hud .player-seat .avatar-wrap, .game-table-hud .user-identity')
      await expect(seats).toHaveCount(4)
      const boxes = []
      for (const seat of await seats.all()) {
        await expect(seat).toBeInViewport({ ratio: 1 })
        const box = (await seat.boundingBox())!
        expect(box.height).toBeLessThanOrEqual(73)
        expect((await seat.locator('.avatar').boundingBox())!.width).toBeLessThanOrEqual(30)
        await expect(seat.locator('.player-name')).toBeHidden()
        await seat.locator('.avatar-button').click()
        await expect(seat.locator('.nickname-popover')).toBeVisible()
        await expect(seat.locator('.nickname-popover')).toBeInViewport({ ratio: 1 })
        await seat.locator('.avatar-button').click()
        await expect(seat.locator('.nickname-popover')).toHaveCount(0)
        boxes.push(box)
      }
      const overlap = (a: typeof boxes[number], b: typeof boxes[number]) =>
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > .5
        && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > .5
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false)
      for (const tile of await page.locator('.hand-rack .mahjong-tile').all()) {
        const rect = (await tile.boundingBox())!
        for (const seat of boxes) expect(overlap(rect, seat)).toBe(false)
      }
      expect((await page.locator('.hand-rack .mahjong-tile').first().boundingBox())!.width).toBeLessThanOrEqual(44)
      await page.screenshot({ path: `test-results/mobile-port/${theme}-${touch ? 'touch' : 'fine'}.png` })
      expect(errors).toEqual([])
      await context.close()
    })
  }
}

test('913×492 desktop keeps full-size avatars and inline names', async ({ page }) => {
  await page.setViewportSize({ width: 913, height: 492 })
  await page.goto('/tests/e2e/fixtures/blood-flow.html?common=1&count=0')
  await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.seat-left .player-name')).toBeVisible()
  expect((await page.locator('.seat-left .avatar').boundingBox())!.width).toBeGreaterThan(30)
})

for (const [width, height] of [[915, 412], [844, 390], [780, 360], [720, 320], [390, 844], [360, 780]]) {
  test(`replay fits ${width}×${height}, panels and perspective remain usable`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    const base = `http://127.0.0.1:${process.env.E2E_PORT || 4173}`
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    // Seed and enter through the real list, including portrait orientation-gate handling.
    await page.goto(`${base}/tests/e2e/fixtures/mobile-replay.html`)
    await expect(page.locator('body')).toHaveAttribute('data-fixture', 'ready')
    await page.setViewportSize({ width: 915, height: 412 })
    await page.goto(`${base}/?theme=jade`)
    await page.getByRole('button', { name: '对局回放 →' }).click()
    await page.setViewportSize({ width, height })
    await expect(page.locator('.orientation-gate')).toHaveCount(0)
    await page.getByRole('button', { name: '查看', exact: true }).click()
    await expect(page.locator('.replay-viewer canvas')).toBeVisible()
    await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('.replay-log-body')).toBeHidden()
    await page.getByTestId('replay-perspective').tap()
    await expect(page.getByTestId('replay-viewer')).toHaveAttribute('data-replay-perspective', 'self')
    await page.getByTestId('replay-perspective').tap()
    await expect(page.getByTestId('replay-viewer')).toHaveAttribute('data-replay-perspective', 'omniscient')
    await page.getByRole('button', { name: '下一步', exact: true }).tap()
    await expect(page.getByTestId('replay-turn').locator('i')).toContainText('2/')
    for (const selector of ['.replay-back', '.replay-view-mode', '.replay-user', '.replay-timeline'])
      await expect(page.locator(selector)).toBeInViewport({ ratio: 1 })
    const fits = await page.evaluate(() => {
      const footer = document.querySelector('.replay-timeline')!.getBoundingClientRect()
      return [...document.querySelectorAll('.replay-hand-rack .mahjong-tile')].every(tile => {
        const r = tile.getBoundingClientRect()
        return r.left >= 0 && r.right <= innerWidth && r.bottom <= footer.top
      }) && document.documentElement.scrollWidth === innerWidth
    })
    expect(fits).toBe(true)
    await page.screenshot({ path: `test-results/mobile-port/replay-${width}x${height}.png` })
    await page.locator('.replay-log-toggle').tap()
    await expect(page.locator('.replay-log-body')).toBeVisible()
    await page.locator('.replay-log-start').tap()
    await expect(page.locator('.replay-log-body')).toBeHidden()
    await page.getByTestId('replay-info-toggle').tap()
    await expect(page.getByTestId('replay-info-body')).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: '关闭分数' }).tap()
    await page.getByRole('button', { name: '← 返回大厅' }).tap()
    await expect(page.getByTestId('replay-viewer')).toHaveCount(0)
    expect(errors).toEqual([])
    await context.close()
  })
}
