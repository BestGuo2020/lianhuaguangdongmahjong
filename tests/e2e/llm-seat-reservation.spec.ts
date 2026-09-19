// 房间面板「预留座位」端到端：房主为某个空位**显式选择模型** ⇒ 该座预留给大模型、真人不可占。
//
// 语义（2026-09 定稿）：「自动选择」= 真人可占（空着由服务端默认提供商补位）；
// 选了具体模型 = 该座只留给这个模型，真人加入时被跳过；改回「自动选择」= 取消预留。
//
// 覆盖范围与分工：
// - 本文件的用例覆盖**浏览器 ↔ 服务端**这一段：下拉改选真的写到房间上、其他客户端看得到、
//   真人 join 真的被推到下一个空座、改回自动选择后真人能坐回来、开局请求真的带上预留座。
// - 开局时「预留座装配成 LLMPlayer（provider/key 正确）」由后端集成测试覆盖
//   （backend/tests/test_room_llm_reservation.py）——那里提供了假注册表，本地跑真模型会产生
//   真实调用与费用，所以这里用一个被拦截的 start 请求只断言前端送出的 llmSeats。
import { expect, test, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })
// vite 冷启动首次转换较慢（其它 e2e 同样放宽）。
test.setTimeout(120_000)

async function prepareRemotePage(page: Page, nickname: string) {
  await page.addInitScript(() => {
    localStorage.setItem('lgm_disclaimer_agreed', '1')
    localStorage.removeItem('lgm_session')
    localStorage.removeItem('lgm_nickname')
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.locator('.mode-selector button').nth(1).click()
  await page.locator('.remote-field input').fill(nickname)
}

/** 建房并勾选「空位使用服务器大模型」（本地 e2e 后端在 backend/.env 里配了提供商）。 */
async function createLlmRoom(page: Page) {
  await page.locator('.remote-create').click()
  await expect(page.locator('.lobby-dialog')).toBeVisible()
  const toggle = page.locator('[data-testid="remote-llm-enabled"]')
  await expect(toggle).toBeEnabled({ timeout: 20_000 })
  await toggle.check()
  await page.locator('.lobby-dialog .dialog-actions .primary').click()
  await expect(page.locator('.room-panel')).toBeVisible({ timeout: 30_000 })
  // 房主视角：三个空位都有提供商下拉（第 1 座是房主自己）。
  await expect(page.locator('[data-testid="room-llm-pick"]')).toHaveCount(3)
}

async function joinByCode(page: Page, roomId: string) {
  await page.locator('.remote-join-btn').click()
  await page.locator('.join-dialog-field input').fill(roomId)
  await page.locator('.lobby-dialog .dialog-actions .primary').click()
  await expect(page.locator('.room-panel')).toBeVisible({ timeout: 30_000 })
}

/** 在第 2 座（index 1）选第一个具体模型，返回该选项值（'' = 自动选择）。 */
async function reserveSecondSeat(page: Page) {
  const pick = page.locator('.room-seat').nth(1).locator('[data-testid="room-llm-pick"]')
  const value = await pick.locator('option').nth(1).getAttribute('value')
  expect(value, '服务端应公布至少一个提供商').toBeTruthy()
  await pick.selectOption(value as string)
  return value as string
}

test('房主为第 2 座选定模型后，真人加入改坐第 3 座（且各端都看到预留）', async ({ browser }) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  try {
    await prepareRemotePage(pageA, '预留房主')
    await createLlmRoom(pageA)
    const value = await reserveSecondSeat(pageA)

    const secondSeat = pageA.locator('.room-seat').nth(1)
    await expect(secondSeat).toHaveAttribute('data-seat-state', 'reserved')
    await expect(pageA.locator('[data-testid="room-llm-reserved-note"]'))
      .toContainText('已预留 1 个空位')
    // 预留写在服务端：等过一个轮询周期（1.5s）后，面板仍显示同一模型（不是本地临时态）。
    await pageA.waitForTimeout(2200)
    await expect(secondSeat.locator('[data-testid="room-llm-pick"]')).toHaveValue(value)
    await expect(secondSeat).toHaveAttribute('data-seat-state', 'reserved')

    const roomId = (await pageA.locator('.room-code strong').textContent()) ?? ''
    expect(roomId).toMatch(/^[A-Z2-9]{6}$/)

    await prepareRemotePage(pageB, '预留乙')
    await joinByCode(pageB, roomId)

    // 真人跳过预留座：乙落在第 3 座；第 2 座在乙的面板上也标着「已预留给大模型」。
    await expect(pageB.locator('.room-seat').nth(2)).toContainText('预留乙')
    await expect(pageB.locator('.room-seat').nth(1)).toHaveAttribute('data-seat-state', 'reserved')
    await expect(pageB.locator('.room-seat').nth(1).locator('.room-seat-reserved'))
      .toContainText('已预留给')
    // 房主端同步看到乙坐在第 3 座。
    await expect(pageA.locator('.room-seat').nth(2)).toContainText('预留乙', { timeout: 10_000 })
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('房主改回「自动选择」= 取消预留，真人立刻能坐回第 2 座', async ({ browser }) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  try {
    await prepareRemotePage(pageA, '放开房主')
    await createLlmRoom(pageA)
    await reserveSecondSeat(pageA)
    await expect(pageA.locator('.room-seat').nth(1)).toHaveAttribute('data-seat-state', 'reserved')

    await pageA.locator('.room-seat').nth(1).locator('[data-testid="room-llm-pick"]').selectOption('')
    await expect(pageA.locator('.room-seat').nth(1)).toHaveAttribute('data-seat-state', 'auto')
    await expect(pageA.locator('[data-testid="room-llm-reserved-note"]')).toHaveCount(0)

    const roomId = (await pageA.locator('.room-code strong').textContent()) ?? ''
    await prepareRemotePage(pageB, '放开乙')
    await joinByCode(pageB, roomId)
    await expect(pageB.locator('.room-seat').nth(1)).toContainText('放开乙')
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('开局请求只带预留座（其余空位交给服务端默认提供商）', async ({ page }) => {
  await prepareRemotePage(page, '开局房主')
  await createLlmRoom(page)
  const value = await reserveSecondSeat(page)
  const [providerId, style] = value.split('::')

  // 拦下 start：只断言前端送出的 llmSeats（不真的起局，避免本地真模型调用）。
  const bodies: string[] = []
  await page.route('**/api/rooms/*/start', async (route) => {
    bodies.push(route.request().postData() ?? '')
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ roomId: 'STUB', status: 'playing' }),
    })
  })

  await page.locator('.room-panel .secondary').click()   // 本家准备
  await expect(page.locator('.room-start')).toBeEnabled({ timeout: 10_000 })
  await page.locator('.room-start').click()

  await expect.poll(() => bodies.length, { timeout: 10_000 }).toBe(1)
  expect(JSON.parse(bodies[0])).toEqual({
    llmSeats: [{ seat: 1, providerId, style }],
  })
})
