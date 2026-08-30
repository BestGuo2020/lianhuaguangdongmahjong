import { expect, test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

test('LLM 配置启用时默认选择专属主题，并尊重 URL 明确覆盖', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('llm.providers', JSON.stringify({
      configVersion: 2,
      enabled: true,
      presets: [{
        id: 'e2e-deepseek',
        name: 'DeepSeek',
        providerType: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'e2e-placeholder',
        model: 'deepseek-chat',
        style: '稳健',
        timeoutMs: 20_000,
      }],
      activeId: 'e2e-deepseek',
      seatIds: [null, null, null, null],
      seatStyles: [null, null, null, null],
    }))
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'llm')

  await page.goto('/?theme=rosewood', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'rosewood')
})

test('大模型主题加载 WebP 桌布并完成 3D 牌桌 ready', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/?theme=llm', { waitUntil: 'domcontentloaded' })
  const textureResponse = page.waitForResponse((response) => response.url().endsWith('/img/llm-table.webp'))
  await page.getByRole('button', { name: /开始东风场/ }).click()

  const response = await textureResponse
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toContain('image/webp')
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('.game-table-hud')).toHaveAttribute('data-table-theme', 'llm')
  expect(pageErrors).toEqual([])
})

test('独立二次元主题可选本家角色并保持现有 LLM 默认推荐不变', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/?theme=llmAnime', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'llmAnime')
  const picker = page.getByRole('radiogroup', { name: '选择本家二次元角色' })
  await expect(picker).toBeVisible()
  await picker.getByRole('radio', { name: '千问大小姐' }).click()
  await expect(picker.getByRole('radio', { name: '千问大小姐' })).toHaveAttribute('aria-checked', 'true')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'llmAnime')
  await expect(page.getByRole('radio', { name: '千问大小姐' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('.game-table-hud')).toHaveAttribute('data-table-theme', 'llmAnime')
  expect(pageErrors).toEqual([])
})
