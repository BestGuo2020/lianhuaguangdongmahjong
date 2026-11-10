import { expect, test } from '@playwright/test'
import { LONG_QUICK_CHAT, sendLongQuickChat } from './fixtures/table-interaction'

test('单机横屏可发快捷语、听到预生成语音并向机器人使用道具', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 844, height: 390 })
  await page.addInitScript(() => localStorage.setItem('lgm_disclaimer_agreed', '1'))
  await page.route('https://gamesvibe.app/sdk/**', route => route.fulfill({ body: '' }))
  await page.route('https://www.googletagmanager.com/**', route => route.fulfill({ body: '' }))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.hand-rack .mahjong-tile').first()).toBeVisible({ timeout: 45_000 })

  const voice = page.waitForResponse(response => response.url().endsWith('/audio/sounds/chat-hundred-ways.mp3'))
  await sendLongQuickChat(page)
  await expect(page.locator('[data-quick-chat-seat="0"]')).toHaveText(LONG_QUICK_CHAT)
  expect((await voice).ok()).toBe(true)
  await page.locator('.player-seat[data-table-seat="1"] .avatar-button').click()
  const emotes = page.getByRole('dialog', { name: /使用互动道具/ })
  await expect(emotes).toBeInViewport({ ratio: 1 })
  await expect(emotes.locator('[data-emote-choice]')).toHaveCount(6)
  await emotes.getByRole('button', { name: '鸡蛋', exact: true }).click()
  await expect(page.locator('.emote-performance[data-emote="egg"][data-from-seat="0"][data-target-seat="1"]')).toHaveCount(1)
  await expect(page.locator('.player-seat[data-table-seat="1"] .table-emote-hit')).toHaveCount(1)
})
