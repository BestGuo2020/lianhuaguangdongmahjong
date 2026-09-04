import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const evidence = 'test-results/theme-presentation/phase12'
const coral = 'rgb(189, 91, 72)'

async function primary(button: Locator) {
  await expect(button).toHaveCSS('background-image', 'linear-gradient(rgb(189, 91, 72), rgb(159, 64, 53))')
  await expect(button).toHaveCSS('color', 'rgb(255, 248, 236)')
}

async function paper(page: Page) {
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveCSS('color-scheme', 'light')
  await expect(dialog).toHaveCSS('color', 'rgb(45, 41, 35)')
  await expect(dialog).toHaveCSS('background-image', 'linear-gradient(150deg, rgb(255, 248, 236), rgb(243, 229, 207))')
  await expect(dialog).toHaveCSS('border-top-color', 'rgb(45, 41, 35)')
  const roots = await page.locator('html, body, .game-app, .lobby').evaluateAll(elements => elements.map(e => ({ x: e.scrollWidth - e.clientWidth, y: e.scrollHeight - e.clientHeight })))
  for (const root of roots) { expect(root.x).toBeLessThanOrEqual(1); expect(root.y).toBeLessThanOrEqual(1) }
}

async function shot(page: Page, name: string) {
  // 截图前只等待视口内的可见图片；不强制加载滚动区中的 lazy 图片。
  await expect.poll(() => page.locator('img').evaluateAll(images => images.filter(img => {
    const r = img.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0
      && r.left < innerWidth && r.right > 0 && getComputedStyle(img).visibility !== 'hidden'
  }).every(img => img.complete && img.naturalWidth > 0)), { timeout: 45_000 }).toBe(true)
  await page.screenshot({ path: `${evidence}/${name}.png`, animations: 'disabled' })
}

test.beforeAll(async () => { await mkdir(evidence, { recursive: true }) })

for (const size of [{ width: 1366, height: 768 }, { width: 667, height: 375 }]) {
  test(`Phase 12 五类纸张弹窗与深色大厅 ${size.width}x${size.height}`, async ({ browser }) => {
    test.setTimeout(120_000)
    const mobile = size.width < 800
    const context = await browser.newContext({ viewport: size, screen: size, hasTouch: mobile, isMobile: mobile })
    const page = await context.newPage()
    await page.addInitScript(() => localStorage.setItem('lgm_disclaimer_agreed', '1'))
    await page.goto('/?theme=llmAnime')
    await expect(page.locator('.orientation-gate')).toHaveCount(0)
    await primary(page.locator('.start-button'))
    await shot(page, `lobby-${size.width}`)
    for (const [index, kind] of ['match', 'rule'].entries()) {
      const summaryBefore = await page.locator('.game-settings').innerText()
      await page.locator('.game-settings button').nth(index).click()
      await paper(page)
      const options = page.locator('.picker-options > button')
      await expect(options.locator('i').first()).toHaveCSS('background-color', coral)
      await expect(page.locator('.picker-options > button:not(.active)')).toHaveCSS('background-color', 'rgb(255, 248, 236)')
      await options.first().focus()
      await page.keyboard.press('Tab')
      await expect(options.nth(1)).toBeFocused()
      await expect(options.nth(1)).toHaveCSS('outline-color', coral)
      await page.keyboard.press('Enter')
      await expect(options.nth(1)).toHaveClass(/active/)
      await expect(options.nth(1)).toHaveCSS('background-color', 'rgb(244, 212, 194)')
      await primary(page.locator('.dialog-actions .primary'))
      await shot(page, `${kind}-${size.width}`)
      await page.locator('.dialog-actions .secondary').click()
      await expect(page.locator('.game-settings')).toHaveText(summaryBefore, { useInnerText: true })
    }
    await page.locator('.character-shortcut').click()
    await paper(page)
    await page.getByRole('radio', { name: /千问大小姐/ }).click()
    await expect(page.getByRole('radio', { name: /千问大小姐/ })).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('.anime-character-grid button.active i')).toHaveCSS('background-color', coral)
    await shot(page, `character-${size.width}`)
    await page.locator('.lobby-dialog-close').click()
    await page.getByRole('radio', { name: /联机对战/ }).click()
    await page.locator('.remote-field input').fill('双表面验收')
    await page.locator('.remote-create').click()
    await paper(page)
    await primary(page.locator('.dialog-actions .primary'))
    await expect(page.locator('.game-settings-title')).toHaveCSS('background-color', 'rgb(243, 229, 207)')
    await shot(page, `create-${size.width}`)
    await page.locator('.dialog-actions .secondary').click()
    await page.locator('.remote-join-btn').click()
    await paper(page)
    const join = page.locator('.dialog-actions .primary')
    await expect(join).toBeDisabled()
    await expect(join).toHaveCSS('box-shadow', 'none')
    await page.locator('.join-dialog-field input').fill('ABC123')
    await expect(join).toBeEnabled()
    await primary(join)
    await shot(page, `join-${size.width}`)
    await page.locator('.lobby-dialog-close').click()
    await expect(page.locator('body')).not.toHaveAttribute('style')
    await context.close()
  })
}

test('Phase 12 配置抽屉保持深色，热切换不改变字段、选项与保存行为', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/?theme=llmAnime')
  await page.getByTestId('llm-fab').click()
  const panel = page.locator('.llm-panel')
  await expect(panel).toHaveCSS('color-scheme', 'dark')
  await expect(panel).toHaveCSS('background-image', 'linear-gradient(160deg, rgb(41, 55, 47), rgb(24, 35, 30) 65%)')
  await page.getByTestId('llm-add').click()
  await page.getByTestId('llm-name').fill('双表面内容保护')
  await page.getByTestId('llm-api-key').fill('visual-test-key')
  await expect(page.getByTestId('llm-api-key')).toHaveAttribute('type', 'password')
  await primary(page.getByTestId('llm-save'))
  const contract = () => panel.locator('[data-testid]').evaluateAll(elements => elements.map(element => ({
    id: element.getAttribute('data-testid'),
    type: element.getAttribute('type'),
    value: (element as HTMLInputElement).value,
    options: element instanceof HTMLSelectElement ? Array.from(element.options).map(o => [o.value, o.text]) : undefined,
  })))
  const before = await contract()
  for (const name of [/默认墨玉/, /大模型二次元/]) {
    // 与既有 Teleport 热切换回归一致，调用真实主题按钮以保持抽屉打开。
    await page.getByLabel('切换牌桌主题').evaluate((e: HTMLButtonElement) => e.click())
    await page.getByRole('menuitemradio', { name }).evaluate((e: HTMLButtonElement) => e.click())
    expect(await contract()).toEqual(before)
  }
  await expect(panel).toHaveAttribute('data-table-theme', 'llmAnime')
  await page.getByTestId('llm-save').click()
  await page.getByTestId('llm-close').click()
  await page.getByTestId('llm-fab').click()
  await expect(page.getByTestId('llm-name')).toHaveValue('双表面内容保护')
  await expect(page.getByTestId('llm-api-key')).toHaveValue('visual-test-key')
  await panel.evaluate(e => { e.scrollTop = 0 })
  await shot(page, 'settings-1366')
  await page.getByTestId('llm-close').click()
  await expect(page.locator('body')).not.toHaveAttribute('style')
})

test('Phase 12 纸张弹层热切换移除浅色变量并保留临时选择', async ({ page }) => {
  await page.goto('/?theme=llmAnime')
  await page.locator('.game-settings button').first().click()
  await page.locator('.picker-options > button').nth(1).click()
  for (const [name, theme] of [['默认墨玉', 'jade'], ['大模型二次元', 'llmAnime']]) {
    await page.getByLabel('切换牌桌主题').evaluate((e: HTMLButtonElement) => e.click())
    await page.getByRole('menuitemradio', { name: new RegExp(name) }).evaluate((e: HTMLButtonElement) => e.click())
    await expect(page.locator('.lobby-dialog-backdrop')).toHaveAttribute('data-table-theme', theme)
    await expect(page.locator('.picker-options > button').nth(1)).toHaveClass(/active/)
    if (theme === 'jade') {
      expect(await page.getByRole('dialog').evaluate(e => getComputedStyle(e).getPropertyValue('--theme-panel').trim())).toBe('#0a231a')
    } else await paper(page)
  }
  await page.locator('.lobby-dialog-close').click()
  await expect(page.locator('body')).not.toHaveAttribute('style')
  await expect(page.locator('body')).not.toHaveAttribute('data-table-theme')
})
