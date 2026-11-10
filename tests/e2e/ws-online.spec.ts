import { expect, test, type Page } from '@playwright/test'
import { expectTableInteractionEcho } from './fixtures/table-interaction'

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

async function createLobbyRoom(page: Page, ruleIndex: number) {
  await page.getByRole('button', { name: '创建房间', exact: true }).click()
  if (ruleIndex > 0) {
    await page.locator('.lobby-dialog .game-settings button').filter({ hasText: '玩法' }).click()
    await page.locator('.rule-picker-options button').nth(ruleIndex).click()
    await page.getByRole('button', { name: '确定', exact: true }).click()
  }
  await page.getByRole('button', { name: '确认创建', exact: true }).click()
  const roomCode = page.locator('.room-code strong')
  await expect(roomCode).toBeVisible({ timeout: 30_000 })
  return (await roomCode.innerText()).trim()
}

test('大厅显示当前玩法，并分别查询各玩法剩余房间', async ({ page, baseURL }) => {
  await enterLobby(page, '玩法容量验收', baseURL!)
  // 只占用经典玩法的名额，用真实后端确认其他玩法的剩余容量独立计算。
  const created = await page.request.post('/api/rooms', {
    data: { mode: 'east', capacity: 4, rulesetId: 'lotus-classic' },
  })
  expect(created.ok()).toBe(true)
  const { roomId } = await created.json()
  const joined = await page.request.post(`/api/rooms/${roomId}/join`, { data: { nickname: '容量占位' } })
  expect(joined.ok()).toBe(true)
  const { seat, rejoinCode } = await joined.json()
  try {
    const rules = [
      { id: 'lotus-classic', name: '莲花广麻' },
      { id: 'lotus-legacy', name: '莲花麻将' },
      { id: 'lotus-blood-flow', name: '莲花麻将·血流' },
    ]
    for (const [index, rule] of rules.entries()) {
      const metaResponse = page.waitForResponse(response => (
        new URL(response.url()).pathname === '/api/rooms/meta'
        && new URL(response.url()).searchParams.get('rulesetId') === rule.id
        && response.request().method() === 'GET'
      ))
      if (index > 0) {
        await page.getByRole('button', { name: '创建房间', exact: true }).click()
        await page.locator('.lobby-dialog .game-settings button').filter({ hasText: '玩法' }).click()
        await page.locator('.rule-picker-options button').nth(index).click()
        await page.getByRole('button', { name: '确定', exact: true }).click()
        await page.getByRole('button', { name: '取消', exact: true }).click()
      }
      const meta = await (await metaResponse).json()
      // 同文件的其他整场用例也可能并行建房，不假定服务端只有本测试的房间。
      if (index === 0) expect(meta.active).toBeGreaterThanOrEqual(1)
      await expect(page.locator('.room-meta-current')).toHaveText(`当前玩法：${rule.name}`)
      await expect(page.locator('.room-meta-note')).toContainText(`剩余房间 ${meta.max - meta.active} / ${meta.max}`)
    }
    await page.screenshot({ path: 'tmp/ws-e2e/current-rule-rooms-desktop.png' })
  } finally {
    await page.request.delete(`/api/rooms/${roomId}`, { data: { seat, rejoinCode } })
  }
})

for (const [ruleIndex, rule] of ['莲花广麻', '莲花麻将', '莲花麻将·血流'].entries()) {
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
      const code = await createLobbyRoom(host, ruleIndex)
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
      await expectTableInteractionEcho(host, guest)
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

for (const [ruleIndex, rule] of [[0, '莲花广麻'], [2, '莲花麻将·血流']] as const) {
  test(`${rule}：终局返回房间，房间回读失败也不会显示暂离`, async ({ page, baseURL }) => {
    await enterLobby(page, '终局验收', baseURL!)
    const code = await createLobbyRoom(page, ruleIndex)
    const savedSession = await page.evaluate(() => localStorage.getItem('lgm_session'))
    const { rejoinCode } = JSON.parse(savedSession!)
    const finish = () => page.request.post(`/api/__e2e__/rooms/${code}/finish`)
    const panel = page.locator('.room-panel')
    const start = panel.getByRole('button', { name: /^开始对局/ })
    try {
      await panel.getByRole('button', { name: '准备 / 取消准备', exact: true }).click()
      await start.click()
      await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 45_000 }).toBeGreaterThan(0)
      await expect(page.locator('.game-table-hud')).toHaveAttribute('data-opening-stage', '', { timeout: 45_000 })

      let syncUnavailable = true
      await page.route(`**/api/rooms/${code}`, route => {
        if (syncUnavailable && route.request().method() === 'GET') return route.fulfill({ status: 503 })
        return route.continue()
      })
      expect((await finish()).ok()).toBe(true)
      await expect(page.getByRole('heading', { name: '最终排名' })).toBeVisible()
      await expect(page.getByRole('button', { name: '退出本场', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: '返回大厅', exact: true }).click()
      await expect(panel).toContainText('房间状态同步失败')
      await expect(panel).not.toContainText(/你在暂离|回到牌桌/)
      await expect(start).toBeDisabled()
      expect(await page.evaluate(() => localStorage.getItem('lgm_session'))).toBe(savedSession)

      syncUnavailable = false
      await expect(panel).toContainText('本场已结束')
      await expect(panel).not.toContainText(/你在暂离|回到牌桌/)
      await expect(start).toBeEnabled()
      await start.click()
      await expect(page.locator('.game-table-hud')).toBeVisible({ timeout: 30_000 })
    } finally {
      await finish()
      await page.request.delete(`/api/rooms/${code}`, { data: { seat: 0, rejoinCode } })
    }
  })
}

test('房间登录过期后隐藏暂离入口，并保留原座位会话', async ({ page, baseURL }) => {
  await enterLobby(page, '过期验收', baseURL!)
  const code = await createLobbyRoom(page, 0)
  const savedSession = await page.evaluate(() => localStorage.getItem('lgm_session'))
  const { rejoinCode } = JSON.parse(savedSession!)
  const panel = page.locator('.room-panel')
  const roomInfo = await (await page.request.get(`/api/rooms/${code}`)).json()
  try {
    await page.route(`**/api/rooms/${code}`, route => route.fulfill({ json: { ...roomInfo, status: 'playing' } }))
    await expect(panel).toContainText('你在暂离')
    await page.unroute(`**/api/rooms/${code}`)
    await page.context().clearCookies()
    await expect(panel).toContainText('登录已过期')
    await expect(panel).not.toContainText(/你在暂离|回到牌桌/)
    await expect(page.locator('[data-wakudemo-account]').getByRole('button', { name: '登录', exact: true })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('lgm_session'))).toBe(savedSession)
  } finally {
    await page.request.delete(`/api/rooms/${code}`, { data: { seat: 0, rejoinCode } })
  }
})
