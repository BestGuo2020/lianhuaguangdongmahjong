// 手机端「用户声明」弹窗：确定按钮必须完整落在卡片内且可点。
// 历史上正文写死 max-height:56vh + 卡片 overflow:hidden，短屏（横屏手机）上按钮行被整行裁掉，
// 只剩一条细边，玩家找不到「同意并继续」。手机竖屏会被 OrientationGate 拦下，所以只验横屏手机。
import { expect, test, type Browser, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

test.setTimeout(120_000)

const evidenceRoot = process.env.E2E_DISCLAIMER_EVIDENCE || 'test-results/disclaimer-mobile'

const viewports = [
  { name: 'iphone-mainstream', width: 844, height: 390, touch: true },
  { name: 'iphone-se', width: 667, height: 375, touch: true },
  { name: 'small-phone', width: 568, height: 320, touch: true },
  { name: 'iphone-pro-max', width: 932, height: 430, touch: true },
  { name: 'window-1280x720', width: 1280, height: 720, touch: false },
  { name: 'tablet-1280x800', width: 1280, height: 800, touch: false },
] as const

async function openDisclaimer(browser: Browser, viewport: typeof viewports[number]) {
  const port = Number(process.env.E2E_PORT || 4173)
  const context = await browser.newContext({
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    isMobile: viewport.touch,
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    localStorage.removeItem('lgm_disclaimer_agreed')
    localStorage.removeItem('lgm_session')
    localStorage.removeItem('lgm_nickname')
  })
  // 不依赖后端 dev bypass 身份：登录态与声明状态都由本用例给答案。
  await page.route('**/api/login/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      authenticated: true,
      account: { id: 'e2e-disclaimer', displayName: '声明验收', avatarUrl: null },
    }),
  }))
  // 本地后端带 dev bypass 身份且已同意声明，必须让服务端回答「未同意」才会弹出声明。
  await page.route('**/api/**/disclaimer-agreement', async (route) => {
    const agreed = route.request().method() !== 'GET'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ playerId: 'e2e-disclaimer', agreed, version: agreed ? 1 : 0 }),
    })
  })
  await page.goto('/')
  await page.locator('.mode-selector button').nth(1).click()
  await page.locator('.remote-field input').fill('声明验收')
  await page.locator('.remote-create').click()
  await expect(page.locator('.lobby-dialog')).toBeVisible()
  const confirm = page.locator('.lobby-dialog .dialog-actions .primary')
  for (let click = 0; click < 3; click++) {
    if (!await page.locator('.lobby-dialog').isVisible()) break
    await confirm.last().click()
  }
  await expect(page.locator('.disclaimer-card')).toBeVisible({ timeout: 30_000 })
  // 入场动画（result-in .48s，起始 scale .94）会让几何量偏小，等 Transition 移除活跃类后再量。
  await expect(page.locator('.disclaimer-backdrop')).not.toHaveClass(/modal-enter-active/, { timeout: 5_000 })
  return { context, page }
}

function rectOf(page: Page, selector: string) {
  return page.evaluate((target) => {
    const element = document.querySelector<HTMLElement>(target)
    if (!element) return null
    const value = element.getBoundingClientRect()
    return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom }
  }, selector)
}

for (const viewport of viewports) {
  test(`用户声明确认按钮完整可见可点（${viewport.name}）`, async ({ browser }) => {
    const { context, page } = await openDisclaimer(browser, viewport)
    try {
      const [card, scroll, accept, decline] = await Promise.all([
        rectOf(page, '.disclaimer-card'),
        rectOf(page, '.disclaimer-scroll'),
        rectOf(page, '.disclaimer-card .result-actions button:not(.secondary)'),
        rectOf(page, '.disclaimer-card .result-actions button.secondary'),
      ])
      await mkdir(evidenceRoot, { recursive: true })
      await page.screenshot({ path: `${evidenceRoot}/${viewport.name}.png` })

      expect(card).not.toBeNull()
      expect(accept).not.toBeNull()
      expect(decline).not.toBeNull()
      expect(scroll).not.toBeNull()

      // 按钮整体在卡片内：不被 overflow:hidden 裁切，也不越出视口。
      for (const button of [accept!, decline!]) {
        expect(button.x).toBeGreaterThanOrEqual(card!.x - 0.5)
        expect(button.right).toBeLessThanOrEqual(card!.right + 0.5)
        expect(button.y).toBeGreaterThanOrEqual(card!.y - 0.5)
        expect(button.bottom).toBeLessThanOrEqual(card!.bottom + 0.5)
        expect(button.right).toBeLessThanOrEqual(viewport.width)
        expect(button.bottom).toBeLessThanOrEqual(viewport.height)
        // 触摸目标尺寸足够（横屏手机必须 ≥44px）。
        expect(button.width).toBeGreaterThanOrEqual(44)
        expect(button.height).toBeGreaterThanOrEqual(44)
      }
      // 正文滚动区在按钮行上方，两者不重叠。
      expect(scroll!.bottom).toBeLessThanOrEqual(accept!.y + 0.5)

      // 真的能点：点击「同意并继续」后声明弹窗关闭。
      await page.getByRole('button', { name: '同意并继续' }).click()
      await expect(page.locator('.disclaimer-card')).toBeHidden()
    } finally {
      await context.close()
    }
  })
}