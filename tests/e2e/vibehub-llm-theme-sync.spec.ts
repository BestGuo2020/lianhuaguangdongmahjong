import { expect, test, type Page } from '@playwright/test'

const llmSettings = {
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
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

async function seedLlmSettings(page: Page, peer: string) {
  await page.goto(`/?mockPeer=${peer}`)
  await page.evaluate((settings) => {
    localStorage.setItem('llm.providers', JSON.stringify(settings))
  }, llmSettings)
}

async function enterRemoteLobby(page: Page, nickname: string, peer: string) {
  await page.goto(`/?mockPeer=${peer}`)
  await page.getByRole('radio', { name: /联机对战/ }).click()
  await page.getByPlaceholder('输入昵称').fill(nickname)
}

async function acceptDisclaimerIfShown(page: Page) {
  const accept = page.getByRole('button', { name: '同意并继续' })
  try {
    await accept.waitFor({ state: 'visible', timeout: 2000 })
    await accept.click()
  } catch {
    // 当前测试 context 已确认过时不会再次显示。
  }
}

test('vibehub 单人模式启用 LLM 后使用大模型专属主题', async ({ page }) => {
  await seedLlmSettings(page, 'theme-solo')
  await page.goto('/?mockPeer=theme-solo')

  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'llm')
  const textureResponse = page.waitForResponse((response) => response.url().endsWith('/img/llm-table.webp'))
  await page.getByRole('button', { name: /开始东风场/ }).click()
  expect((await textureResponse).ok()).toBe(true)
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('.game-table-hud')).toHaveAttribute('data-table-theme', 'llm')
})

test('vibehub 房主的大模型房间主题同步到客户端并用于联机牌桌', async ({ context, page: host }) => {
  const client = await context.newPage()
  const errors = [[], []] as string[][]
  host.on('pageerror', (error) => errors[0].push(error.message))
  client.on('pageerror', (error) => errors[1].push(error.message))

  try {
    // 房主先读取出可用大模型与默认专属主题；随后暂时清空共享 localStorage，
    // 让同 context 的客户端以默认墨玉启动，证明其 llm 主题来自房主同步而非本地配置。
    await seedLlmSettings(host, 'theme-host')
    await enterRemoteLobby(host, '主题房主', 'theme-host')
    await expect(host.locator('main.game-app')).toHaveAttribute('data-table-theme', 'llm')
    await host.evaluate(() => localStorage.removeItem('llm.providers'))

    await enterRemoteLobby(client, '主题客人', 'theme-client')
    await expect(client.locator('main.game-app')).toHaveAttribute('data-table-theme', 'jade')
    await host.evaluate((settings) => {
      localStorage.setItem('llm.providers', JSON.stringify(settings))
    }, llmSettings)

    await host.getByRole('button', { name: '创建房间', exact: true }).click()
    await host.getByRole('button', { name: '确认创建', exact: true }).click()
    await acceptDisclaimerIfShown(host)
    await host.locator('.room-code strong').waitFor({ timeout: 20_000 })
    const roomCode = (await host.locator('.room-code strong').innerText()).trim()

    await client.getByRole('button', { name: '加入房间', exact: true }).click()
    await client.getByPlaceholder('输入 6 位房间码').fill(roomCode)
    await client.getByRole('button', { name: '确认加入', exact: true }).click()
    await acceptDisclaimerIfShown(client)
    try {
      await client.getByRole('button', { name: '准备 / 取消准备', exact: true }).waitFor({ timeout: 25_000 })
    } catch (error) {
      const state = await client.locator('main').innerText().catch(() => '')
      throw new Error(`客户端未完成入座：${state}`, { cause: error })
    }

    // 客户端原本是 jade，收到房主 roster 后必须切成 llm。
    await expect(client.locator('main.game-app')).toHaveAttribute('data-table-theme', 'llm', { timeout: 15_000 })

    // 配置一个房主浏览器运行的 DeepSeek 座位，并验证客户端收到公开身份。
    const llmPicks = host.getByTestId('room-llm-pick')
    await expect(llmPicks).toHaveCount(2)
    await llmPicks.first().selectOption({ index: 1 })
    await expect(host.locator('.room-seat.llm-planned')).toHaveCount(1)
    await expect(client.locator('.room-seat.llm-planned')).toHaveCount(1, { timeout: 15_000 })

    await host.getByRole('button', { name: '准备 / 取消准备', exact: true }).click()
    await client.getByRole('button', { name: '准备 / 取消准备', exact: true }).click()
    const start = host.getByRole('button', { name: /开始对局/ })
    await expect(start).toBeEnabled({ timeout: 20_000 })
    const clientTexture = client.waitForResponse((response) => response.url().endsWith('/img/llm-table.webp'))
    await start.click()

    expect((await clientTexture).ok()).toBe(true)
    await expect(client.locator('.table-loading')).toBeHidden({ timeout: 40_000 })
    await expect(client.locator('.game-table-hud')).toHaveAttribute('data-table-theme', 'llm')
    await expect(host.locator('.game-table-hud')).toHaveAttribute('data-table-theme', 'llm')
    expect(errors).toEqual([[], []])
  } finally {
    await client.close()
  }
})
