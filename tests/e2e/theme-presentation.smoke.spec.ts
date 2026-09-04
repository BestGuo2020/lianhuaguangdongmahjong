import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const evidenceRoot = 'test-results/theme-presentation'

test('欢乐麻将形成大厅、HUD、加载和结算连续表现', async ({ page }) => {
  test.setTimeout(120_000)
  await mkdir(evidenceRoot, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/?theme=happyMahjong&winEffectLab=1', { waitUntil: 'domcontentloaded' })

  const shell = page.locator('main.game-app')
  await expect(shell).toHaveAttribute('data-table-theme', 'happyMahjong')
  await expect(shell).toHaveAttribute('data-theme-player-frame', 'playful')
  await expect(shell).toHaveAttribute('data-theme-loading', 'happy-orbit')
  await expect(page.locator('.start-button')).toHaveCSS('border-radius', '18px')
  await page.locator('.win-effect-lab').evaluate((element: HTMLElement) => { element.style.visibility = 'hidden' })
  await page.screenshot({ path: `${evidenceRoot}/happyMahjong-lobby-1366x768.png` })

  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('.game-table-hud')).toHaveAttribute('data-table-theme', 'happyMahjong')
  await expect(page.locator('.seat-left .avatar-wrap')).toHaveCSS('border-radius', '22px')
  await page.screenshot({ path: `${evidenceRoot}/happyMahjong-table-1366x768.png` })

  await page.getByTestId('win-self-0').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.settlement-card')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('.settlement-card')).toHaveCSS('border-radius', '26px')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${evidenceRoot}/happyMahjong-settlement-1366x768.png` })
})
