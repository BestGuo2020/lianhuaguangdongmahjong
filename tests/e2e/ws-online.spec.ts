import { expect, test, type Page } from '@playwright/test'

test.setTimeout(300_000)
test.skip(process.env.E2E_WS !== '1', '真实 WS 后端验收通过 E2E_WS=1 显式运行')

async function enterLobby(page: Page, nickname: string, baseURL: string) {
  const login = await page.request.post(`${baseURL}/api/__e2e__/login`, { data: { nickname } })
  expect(login.ok()).toBe(true)
  await page.addInitScript(() => {
    localStorage.setItem('lgm_disclaimer_agreed', '1')
    ;(window as any).__unexpectedVibeInit = 0
    ;(window as any).VibeHub = { init: () => { (window as any).__unexpectedVibeInit += 1; throw new Error('WS must not initialize VibeHub') } }
  })
  await page.route('https://gamesvibe.app/sdk/v3/vibehub.js', route => route.fulfill({ body: '' }))
  await page.route('https://www.googletagmanager.com/**', route => route.fulfill({ body: '' }))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-wakudemo-account]')).toContainText('已安全登录', { timeout: 30_000 })
  await page.getByRole('radio', { name: /联机对战/ }).click()
  await page.getByPlaceholder('输入昵称').fill(nickname)
}

for (const rule of ['莲花广麻', '莲花麻将', '莲花麻将·血流']) {
  test(`${rule}：原后端建房、两端开局、刷新后凭会话恢复`, async ({ browser, baseURL }) => {
    const hostContext = await browser.newContext()
    const guestContext = await browser.newContext()
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()
    const errors: string[] = []
    const sockets: string[] = []
    for (const page of [host, guest]) {
      page.on('pageerror', error => errors.push(error.message))
      page.on('websocket', socket => { if (socket.url().includes('/ws/room/')) sockets.push(socket.url().split('?')[0]) })
    }
    try {
      await enterLobby(host, 'WS房主', baseURL!)
      await host.getByRole('button', { name: '创建房间', exact: true }).click()
      if (rule !== '莲花广麻') {
        await host.locator('.lobby-dialog .game-settings button').filter({ hasText: '玩法' }).click()
        await host.locator('.rule-picker-options button').nth(rule === '莲花麻将' ? 1 : 2).click()
        await host.getByRole('button', { name: '确定', exact: true }).click()
      }
      await host.getByRole('button', { name: '确认创建', exact: true }).click()
      await expect(host.locator('.room-code strong')).toBeVisible({ timeout: 30_000 })
      const code = (await host.locator('.room-code strong').innerText()).trim()
      await enterLobby(guest, 'WS客人', baseURL!)
      if (rule === '莲花广麻') {
        // 本机上次选了血流也应按目标房间元数据切回经典 WS 端口。
        await guest.getByRole('radio', { name: /单机对战/ }).click()
        await guest.locator('.game-settings button').filter({ hasText: '玩法' }).click()
        await guest.locator('.rule-picker-options button').nth(2).click()
        await guest.getByRole('button', { name: '确定', exact: true }).click()
        await guest.getByRole('radio', { name: /联机对战/ }).click()
      }
      await guest.getByRole('button', { name: '加入房间', exact: true }).click()
      await guest.getByPlaceholder('输入 6 位房间码').fill(code)
      await guest.getByRole('button', { name: '确认加入', exact: true }).click()
      await expect(guest.locator('.room-code strong')).toHaveText(code, { timeout: 30_000 })
      for (const page of [host, guest]) await page.getByRole('button', { name: '准备 / 取消准备', exact: true }).click()
      await expect(host.locator('.room-start')).toBeEnabled()
      await host.locator('.room-start').click()
      for (const page of [host, guest]) {
        await expect(page.locator('.game-table-hud')).toBeVisible({ timeout: 30_000 })
        // 初始空桌的 openingStage 也是空；先看到发牌，再等待开场真正结束。
        await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 45_000 }).toBeGreaterThan(0)
        await expect(page.locator('.game-table-hud')).toHaveAttribute('data-opening-stage', '', { timeout: 45_000 })
        expect(await page.evaluate(() => (window as any).__unexpectedVibeInit)).toBe(0)
      }
      await guest.reload({ waitUntil: 'domcontentloaded' })
      await expect(guest.locator('[data-wakudemo-account]')).toContainText('已安全登录')
      await guest.locator('.continue-session').click()
      await expect(guest.locator('.game-table-hud')).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => guest.locator('.hand-tile-slot').count(), { timeout: 30_000 }).toBeGreaterThan(0)
      await expect(guest.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
      expect(sockets.length).toBeGreaterThanOrEqual(3)
      expect(errors).toEqual([])
      await guest.screenshot({ path: `tmp/ws-e2e/${rule}-rejoined.png` })
    } finally {
      await hostContext.close()
      await guestContext.close()
    }
  })
}
