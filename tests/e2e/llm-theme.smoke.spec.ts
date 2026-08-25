import { expect, test } from '@playwright/test'

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

  await page.goto('/')
  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'llm')

  await page.goto('/?theme=rosewood')
  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'rosewood')
})

test('大模型主题加载 WebP 桌布并完成 3D 牌桌 ready', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/?theme=llm')
  const textureResponse = page.waitForResponse((response) => response.url().endsWith('/img/llm-table.webp'))
  await page.getByRole('button', { name: /开始东风场/ }).click()

  const response = await textureResponse
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toContain('image/webp')
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('.game-table-hud')).toHaveAttribute('data-table-theme', 'llm')
  expect(pageErrors).toEqual([])
})
