import { expect, test } from '@playwright/test'

test('横屏顶栏和完整规则按当前玩法显示', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 })
  await page.addInitScript(() => localStorage.setItem('lgm_disclaimer_agreed', '1'))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const topBar = page.locator('.top-bar')
  await page.locator('.game-app').evaluate((app: HTMLElement) => {
    app.style.setProperty('--safe-left', '40px')
    app.style.setProperty('--safe-right', '26px')
  })
  await expect(topBar).toHaveCSS('left', '40px')
  await expect(topBar).toHaveCSS('padding-left', '8px')
  await expect(topBar.locator('nav').locator('.table-control-icon')).toHaveCount(3)
  await expect(topBar.getByRole('button', { name: '声音设置' })).toHaveCSS('width', '44px')

  for (const [index, title] of ['莲花广麻玩法', '莲花麻将玩法', '莲花麻将·血流玩法'].entries()) {
    if (index > 0) {
      await page.locator('.game-settings button').filter({ hasText: '玩法' }).click()
      await page.locator('.rule-picker-options button').nth(index).click()
      await page.getByRole('button', { name: '确定', exact: true }).click()
    }
    await topBar.getByRole('button', { name: '查看规则' }).click()
    const trigger = page.getByRole('button', { name: '查看完整规则', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: `${title} · 完整规则` })
    await expect(dialog).toBeInViewport({ ratio: 1 })
    const table = dialog.getByRole('table', { name: ['买马与结算', '胡牌牌型', '血流番型'][index] })
    await expect(table).toContainText(['中马牌', '十三幺', '十二落抬'][index])
    const region = dialog.getByRole('region', { name: '规则正文' })
    expect(await region.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await page.getByRole('button', { name: '关闭规则', exact: true }).click()
  }
})

test('横屏托管独立显示，安全区只计一次，头像随手牌长度调整', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 })
  for (const count of [14, 5]) {
    await page.goto(`/tests/e2e/fixtures/common-hand-gap.html?variant=legacy&count=${count}&controls=1`)
    await page.locator('.game-app').evaluate((app: HTMLElement) => {
      app.style.setProperty('--safe-left', '30px')
      app.style.setProperty('--safe-right', '20px')
      app.style.setProperty('--safe-bottom', '18px')
    })
    await expect(page.locator('.table-controls')).toHaveCSS('bottom', '96px')
    const row = page.locator('.turn-action-row')
    const persistent = page.locator('.table-persistent-actions')
    await expect(row.getByRole('button', { name: '风杠' })).toBeVisible()
    await expect(row.locator('.turn-timer')).toHaveText('9')
    const autoplay = persistent.getByRole('button')
    await expect(autoplay).toHaveAttribute('aria-pressed', 'false')
    const background = await autoplay.evaluate(element => getComputedStyle(element).backgroundColor)
    await autoplay.click()
    await expect(autoplay).toHaveAttribute('aria-pressed', 'true')
    await expect(autoplay).toHaveCSS('background-color', background)
    await expect(autoplay).toHaveCSS('outline-style', 'solid')
    const identity = page.locator('.user-identity')
    await expect(identity).not.toHaveClass(/\bbeside-hand\b/)
    const tiles = page.locator('.hand-rack .mahjong-tile')
    expect((await tiles.first().boundingBox())!.x).toBeGreaterThanOrEqual(30)
    const last = (await tiles.last().boundingBox())!
    expect(last.x + last.width).toBeLessThanOrEqual(548)
    if (count === 5) {
      await page.setViewportSize({ width: 915, height: 320 })
      await expect(identity).toHaveClass(/\bbeside-hand\b/)
    }
  }
})

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
