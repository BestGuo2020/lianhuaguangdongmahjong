import { expect, test, type Page } from '@playwright/test'

test.setTimeout(120_000)
test.afterEach(async ({ page }) => {
  // 大厅会预取音频；离开测试时收束代理，避免后台请求在页面关闭后报错。
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})
const site = 'https://lianhuaguangdongmahjong.guoguo-labs.online'

async function serveSite(page: Page, baseURL: string, origin = site) {
  // 以真实部署的 hostname 运行本地页面，域名路由不靠测试开关绕过。
  await page.route('https://gamesvibe.app/sdk/v3/vibehub.js', route => route.fulfill({ body: '' }))
  await page.route('https://www.googletagmanager.com/**', route => route.fulfill({ body: '' }))
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url())
    const local = new URL(`${url.pathname}${url.search}`, baseURL)
    const response = await route.fetch({ url: local.href,
      headers: { ...route.request().headers(), host: local.host } })
    await route.fulfill({ response })
  })
}

test('独立站显示 WakuDemo 登录，按钮跳到原后端授权入口', async ({ page, baseURL }) => {
  await serveSite(page, baseURL!)
  await page.route('**/api/login/session', route => route.fulfill({ json: { authenticated: false } }))
  await page.route('**/api/login/wakudemo', route => route.fulfill({ contentType: 'text/html', body: '<h1>授权入口</h1>' }))
  await page.goto(site, { waitUntil: 'domcontentloaded' })
  const card = page.locator('[data-wakudemo-account]')
  await expect(card).toContainText('WakuDemo 账号')
  await expect(card.getByRole('button', { name: '登录', exact: true })).toBeEnabled()
  await card.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(`${site}/api/login/wakudemo`)
})

test('登录回调恢复账号资料，退出后回到未登录状态', async ({ page, baseURL }) => {
  await serveSite(page, baseURL!)
  let authenticated = true
  let logoutMethod = ''
  await page.route('**/api/login/session', route => route.fulfill({ json: authenticated
    ? { authenticated: true, account: { id: 'waku-account', displayName: 'Waku 测试玩家', avatarUrl: null } }
    : { authenticated: false } }))
  await page.route('**/api/login/logout', route => {
    logoutMethod = route.request().method()
    authenticated = false
    return route.fulfill({ json: { authenticated: false } })
  })
  await page.goto(`${site}/?wakudemo_login=success&theme=rosewood#account`, { waitUntil: 'domcontentloaded' })
  const card = page.locator('[data-wakudemo-account]')
  await expect(card).toContainText('Waku 测试玩家')
  await expect(card).toContainText('已安全登录')
  await expect(page).toHaveURL(`${site}/?theme=rosewood#account`)
  await card.getByRole('button', { name: '退出', exact: true }).click()
  await expect(card.getByRole('button', { name: '登录', exact: true })).toBeEnabled()
  expect(logoutMethod).toBe('POST')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(card).toContainText('WakuDemo 账号')
})

test('授权取消与会话检查失败不隐藏账号入口，也不阻塞单机', async ({ page, baseURL }) => {
  await serveSite(page, baseURL!)
  await page.route('**/api/login/session', route => route.fulfill({ status: 503, json: {} }))
  await page.goto(`${site}/?wakudemo_login=error&wakudemo_error=authorization_cancelled`, { waitUntil: 'domcontentloaded' })
  const card = page.locator('[data-wakudemo-account]')
  await expect(card.getByRole('alert')).toHaveText('已取消 WakuDemo 授权')
  await expect(card.getByRole('button', { name: '登录', exact: true })).toBeEnabled()
  await expect(page.locator('.start-button')).toBeEnabled()
})

test('VibeHub 平台不显示 WakuDemo，也不请求独立站账号接口', async ({ page, baseURL }) => {
  const platform = 'https://apps.gamesvibe.app'
  await serveSite(page, baseURL!, platform)
  const accountRequests: string[] = []
  page.on('request', request => {
    if (request.url().includes('/api/login/')) accountRequests.push(request.url())
  })
  await page.goto(platform, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.start-button')).toBeVisible()
  await expect(page.locator('[data-wakudemo-account]')).toHaveCount(0)
  expect(accountRequests).toEqual([])
})
