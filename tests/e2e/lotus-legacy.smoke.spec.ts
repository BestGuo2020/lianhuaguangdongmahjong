import { expect, test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

test('莲花麻将（旧版翻精）仅单机：选择玩法、开始对局并亮出精指示牌', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/')

  // 选择「莲花麻将」玩法
  await page.locator('.game-settings button', { hasText: '玩法' }).click()
  await page.getByRole('button', { name: /莲花麻将/ }).click()
  await page.getByRole('button', { name: '确定' }).click()

  // 单机专用提示 + 联机入口被隐藏
  await expect(page.getByText('莲花麻将（旧版翻精）仅支持单机对战')).toBeVisible()
  await expect(page.getByRole('button', { name: /联机对战/ })).toHaveCount(0)

  // 开始对局
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.game-table-hud')).toBeVisible()
  await expect(page.locator('canvas.mahjong-scene')).toBeVisible({ timeout: 15_000 })

  // 翻精指示牌出现（开局含两次掷骰 + 翻精，且音效会拉长等待，放宽到 30s），
  // 且开牌流程推进（手牌出现）
  await expect(page.locator('.flip-indicator')).toBeVisible({ timeout: 30_000 })
  await expect.poll(
    () => page.locator('.hand-tile-slot').count(),
    { timeout: 30_000, message: '莲花麻将开局应完成发牌' },
  ).toBeGreaterThanOrEqual(4)

  expect(pageErrors).toEqual([])
})
