import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const evidence = process.env.PHASE11V_EVIDENCE_DIR || 'test-results/phase11v'
const themes = [
  ['jade', '默认墨玉'], ['happyMahjong', '欢乐麻将'], ['rosewood', '红木金丝'],
  ['llm', '大模型专属'], ['llmAnime', '大模型二次元'],
] as const
const settings = {
  configVersion: 2, enabled: true,
  presets: [{ id: 'visual-provider', name: 'DeepSeek', providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-placeholder', model: 'deepseek-chat', style: '稳健', timeoutMs: 20_000 }],
  activeId: 'visual-provider', seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
}

async function switchTheme(page: Page, label: string, covered = false) {
  const toggle = page.getByLabel('切换牌桌主题')
  if (covered) await toggle.evaluate((e: HTMLButtonElement) => e.click())
  else await toggle.click()
  const option = page.getByRole('menuitemradio', { name: new RegExp(label) })
  if (covered) await option.evaluate((e: HTMLButtonElement) => e.click())
  else await option.click()
}

async function capture(page: Page, name: string) {
  await expect.poll(() => page.locator('.theme-showcase-frame img').evaluateAll(images => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
  await page.screenshot({ path: `${evidence}/${name}.png`, scale: 'css', animations: 'disabled' })
}

test.beforeAll(async () => { await mkdir(evidence, { recursive: true }) })
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem('lgm_disclaimer_agreed', '1'))
  await context.route('https://api.deepseek.com/**', route => route.fulfill({ status: 503, body: '{}' }))
})

test('P2P 壳层五主题大厅、选择与房间弹窗、配置抽屉显式接收主题', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const styles: string[] = []
  for (const [theme] of themes) {
    await page.goto(`/?theme=${theme}&mockPeer=surfaces-${theme}`)
    const root = page.locator('.game-app')
    await expect(root).toHaveAttribute('data-table-theme', theme)
    await expect(root).toHaveAttribute('data-theme-player-frame', /jade|playful|wood|cosmic|anime/)
    await expect(root).toHaveAttribute('data-theme-loading', /.+/)
    await expect(root).toHaveClass(/theme-heading-/)
    await expect(page.locator('.theme-showcase')).toHaveAttribute('data-preview-state', 'ready')
    await expect(page.locator('.start-button')).toHaveAttribute('data-action-role', 'primary')
    await capture(page, `${theme}-lobby`)
    for (const [index, kind] of ['match', 'rule'].entries()) {
      await page.locator('.game-settings button').nth(index).click()
      await expect(page.locator('.lobby-dialog-backdrop')).toHaveAttribute('data-table-theme', theme)
      await expect(page.locator('.lobby-dialog')).toHaveClass(new RegExp(`${kind}-dialog`))
      if (theme === 'llmAnime') {
        await expect(page.locator('.lobby-dialog')).toHaveCSS('color-scheme', 'light')
        await expect(page.locator('.dialog-actions .primary')).toHaveCSS('color', 'rgb(255, 248, 236)')
      }
      await capture(page, `${theme}-${kind}`)
      await page.locator('.lobby-dialog-close').click()
    }
    if (theme === 'llmAnime') {
      await page.getByRole('button', { name: '更换本家形象' }).click()
      await expect(page.locator('.lobby-dialog')).toHaveClass(/character-dialog/)
      await expect(page.locator('.lobby-dialog-backdrop')).toHaveAttribute('data-table-theme', theme)
      await capture(page, `${theme}-character`)
      await page.getByRole('radio', { name: /千问大小姐/ }).click()
      await expect(page.locator('.lobby-dialog')).toHaveCount(0)
      await expect(page.locator('.theme-showcase-copy strong')).toHaveText('千问大小姐')
    }
    await page.getByTestId('llm-fab').click()
    const panel = page.locator('.llm-panel')
    await expect(panel).toHaveAttribute('data-table-theme', theme)
    await expect(panel).toHaveCSS('color-scheme', 'dark')
    styles.push(await panel.evaluate(e => getComputedStyle(e).backgroundImage))
    await page.getByTestId('llm-add').click()
    await page.getByTestId('llm-name').fill('配置内容保护')
    await page.getByTestId('llm-api-key').fill('masked-placeholder')
    const contract = () => panel.locator('[data-testid]').evaluateAll(elements => elements.map(e => ({
      id: e.getAttribute('data-testid'), type: e.getAttribute('type'), value: (e as HTMLInputElement).value,
      options: e instanceof HTMLSelectElement ? [...e.options].map(o => [o.value, o.text]) : undefined,
    })))
    const before = await contract()
    const next = theme === 'jade' ? themes[4] : themes[0]
    await switchTheme(page, next[1], true)
    await expect(panel).toHaveAttribute('data-table-theme', next[0])
    expect(await contract()).toEqual(before)
    await switchTheme(page, themes.find(t => t[0] === theme)![1], true)
    await expect(page.getByTestId('llm-api-key')).toHaveAttribute('type', 'password')
    await panel.evaluate(e => { e.scrollTop = 0 })
    await capture(page, `${theme}-settings`)
    await page.getByTestId('llm-save').click()
    await page.getByTestId('llm-close').click()
    await page.getByTestId('llm-fab').click()
    await expect(page.getByTestId('llm-name')).toHaveValue('配置内容保护')
    await page.getByTestId('llm-close').click()
    await page.getByRole('radio', { name: /联机对战/ }).click()
    await page.getByPlaceholder('输入昵称').fill('主题验证')
    for (const kind of ['create', 'join']) {
      await page.locator(kind === 'create' ? '.remote-create' : '.remote-join-btn').click()
      const dialog = page.locator('.lobby-dialog-backdrop')
      await expect(dialog).toHaveAttribute('data-table-theme', theme)
      const value = page.locator('.join-dialog-field input')
      if (kind === 'join') await value.fill('ABC123')
      await switchTheme(page, next[1], true)
      await expect(dialog).toHaveAttribute('data-table-theme', next[0])
      if (kind === 'join') await expect(value).toHaveValue('ABC123')
      await switchTheme(page, themes.find(t => t[0] === theme)![1], true)
      await capture(page, `${theme}-${kind}`)
      await page.locator('.dialog-actions .secondary').click()
    }
    await expect(page.locator('body')).not.toHaveAttribute('data-table-theme')
    await expect(page.locator('body')).not.toHaveAttribute('style')
    await page.evaluate(() => localStorage.removeItem('llm.providers'))
  }
  expect(new Set(styles).size).toBe(5)
})

test('P2P 双客户端移动房间、AI 上限、主题锁定与重连恢复', async ({ browser }) => {
  test.setTimeout(150_000)
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true })
  await context.addInitScript((config) => {
    localStorage.setItem('lgm_disclaimer_agreed', '1')
    localStorage.setItem('llm.providers', JSON.stringify(config))
  }, settings)
  const host = await context.newPage()
  let client = await context.newPage()
  for (const [page, peer, nickname] of [[host, 'shell-host', '房主'], [client, 'shell-client', '客人']] as const) {
    await page.goto(`/?theme=jade&mockPeer=${peer}`)
    await page.getByRole('radio', { name: /联机对战/ }).click()
    await page.getByPlaceholder('输入昵称').fill(nickname)
  }
  await host.locator('.remote-create').click()
  await host.locator('.dialog-actions .primary').click()
  await expect(host.locator('.room-code strong')).toBeVisible()
  const code = await host.locator('.room-code strong').innerText()
  const picks = host.getByTestId('room-llm-pick')
  await expect(picks).toHaveCount(3)
  await picks.nth(0).selectOption({ index: 1 })
  await picks.nth(1).selectOption({ index: 1 })
  await expect(picks.nth(2)).toBeDisabled()
  await expect(host.locator('.room-seat.llm-planned')).toHaveCount(2)
  await client.locator('.remote-join-btn').click()
  await client.getByPlaceholder('输入 6 位房间码').fill(code)
  await client.locator('.dialog-actions .primary').click()
  await expect(client.getByRole('button', { name: '准备 / 取消准备', exact: true })).toBeVisible({ timeout: 25_000 })
  for (const [theme, label] of themes) {
    await switchTheme(host, label)
    await expect(client.locator('.game-app')).toHaveAttribute('data-table-theme', theme)
    await expect(client.getByLabel('切换牌桌主题')).toBeDisabled()
    await expect(host.locator('.lobby-visual')).toBeHidden()
    await expect(host.locator('.room-panel .anime-character-picker')).toHaveCount(0)
    await capture(host, `${theme}-room-844`)
  }
  for (const size of [{ width: 844, height: 390 }, { width: 800, height: 360 }, { width: 667, height: 375 }, { width: 568, height: 320 }]) {
    await host.setViewportSize(size)
    const measure = async () => host.evaluate(() => {
      const room = document.querySelector('.room-panel')!.getBoundingClientRect()
      const code = document.querySelector('.room-code strong')!.getBoundingClientRect()
      return { center: code.x + code.width / 2, roomCenter: room.x + room.width / 2 }
    })
    const before = await measure()
    expect(Math.abs(before.center - before.roomCenter)).toBeLessThanOrEqual(2)
    await host.locator('.room-code').click()
    await expect(host.locator('.room-code-copied')).toHaveClass(/visible/)
    expect(Math.abs((await measure()).center - before.center)).toBeLessThanOrEqual(1)
    const geometry = await host.evaluate(() => ({
      roots: ['html', 'body', '.game-app', '.lobby'].map(s => { const e = document.querySelector(s)!; return [e.scrollWidth - e.clientWidth, e.scrollHeight - e.clientHeight] }),
      content: [...document.querySelectorAll('.room-seat, .room-owner-actions button, .room-actions-row button')].map(e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }),
    }))
    for (const [x, y] of geometry.roots) { expect(x).toBeLessThanOrEqual(1); expect(y).toBeLessThanOrEqual(1) }
    for (const r of geometry.content) { expect(r.top).toBeGreaterThanOrEqual(0); expect(r.bottom).toBeLessThanOrEqual(size.height) }
    await capture(host, `llmAnime-room-${size.width}`)
  }
  await host.locator('.room-character-entry').click()
  await expect(host.locator('.lobby-dialog-backdrop')).toHaveAttribute('data-table-theme', 'llmAnime')
  await expect(host.locator('.lobby-dialog')).toHaveClass(/character-dialog/)
  await host.getByRole('radio', { name: /千问大小姐/ }).click()
  await expect(host.locator('.room-character-entry')).toContainText('千问大小姐')
  const reconnectUrl = client.url()
  await client.close()
  // 本地 SDK mock 通过心跳识别关页；等断线事实落地后用同一身份重进。
  await expect(host.locator('.room-seat.occupied')).toHaveCount(1, { timeout: 20_000 })
  client = await context.newPage()
  await client.goto(reconnectUrl)
  await expect(client.locator('.room-code strong')).toHaveText(code, { timeout: 30_000 })
  await expect(client.locator('.game-app')).toHaveAttribute('data-table-theme', 'llmAnime')
  await expect(client.getByLabel('切换牌桌主题')).toBeDisabled()
  await expect(client.getByRole('button', { name: '准备 / 取消准备', exact: true })).toBeVisible()
  await host.getByRole('button', { name: '准备 / 取消准备', exact: true }).click()
  await client.getByRole('button', { name: '准备 / 取消准备', exact: true }).click()
  await expect(host.locator('.room-start')).toBeEnabled()
  await expect(host.locator('.room-start')).toHaveAttribute('data-action-role', 'primary')
  host.once('dialog', d => d.accept())
  await host.getByRole('button', { name: '关闭房间', exact: true }).click()
  await expect(host.locator('.room-panel')).toHaveCount(0)
  await context.close()
})
