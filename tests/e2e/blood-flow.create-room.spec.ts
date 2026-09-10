// 血流联机建房按钮的加载态：建房请求在途时按钮显示「创建中…」且禁用（防连点重复建房）。
// 用路由延迟把 1.5s 的窗口拉长到可观测；断言的是真实浏览器里的按钮文案与 disabled 属性。
import { expect, test, type Page } from '@playwright/test'

// vite 冷启动首次转换较慢（其它 e2e 同样放宽），业务本身只需数秒。
test.setTimeout(120_000)

async function prepareRemotePage(page: Page, nickname: string) {
  await page.addInitScript(() => {
    localStorage.setItem('lgm_disclaimer_agreed', '1')
    localStorage.removeItem('lgm_session')
    localStorage.removeItem('lgm_nickname')
  })
  await page.goto('/')
  await page.locator('.mode-selector button').nth(1).click()
  await page.locator('.remote-field input').fill(nickname)
}

test('创建房间在途时按钮显示「创建中…」且禁用', async ({ page }) => {
  await prepareRemotePage(page, '建房加载态')
  // 只延迟 POST /api/rooms（GET /api/rooms/meta 不受影响）。
  await page.route('**/api/rooms', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })

  const create = page.locator('.remote-create')
  await create.click()
  await expect(page.locator('.lobby-dialog')).toBeVisible()
  // 在新建房对话框里选「莲花麻将·血流」，让建房走血流联机模块。
  await page.locator('.lobby-dialog .game-settings > button').nth(1).click()
  await page.locator('.rule-picker-options button').nth(2).click()
  await page.locator('.lobby-dialog .dialog-actions .primary').click()   // 确认规则
  await page.locator('.lobby-dialog .dialog-actions .primary').click()   // 确认创建 → 触发 POST

  // 请求在途：按钮文案 + 禁用（此前血流模块不置 creating，按钮一直可点、无加载态）。
  await expect(create).toHaveText(/创建中…/)
  await expect(create).toBeDisabled()

  // 请求完成后进入房间面板（此时建房入口已换成房间面板，加载态自然消失）。
  await expect(page.locator('.room-panel')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.room-panel')).toContainText('莲花麻将·血流')
  await expect(create).toHaveCount(0)
})
