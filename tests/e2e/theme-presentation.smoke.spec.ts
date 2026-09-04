import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const evidenceRoot = 'test-results/theme-presentation'

const phaseFiveThemes = [
  { name: 'jade', frame: 'jade', loading: 'jade-facet' },
  { name: 'rosewood', frame: 'wood', loading: 'wood-lantern' },
  { name: 'llm', frame: 'cosmic', loading: 'llm-scan' },
  { name: 'llmAnime', frame: 'anime', loading: 'anime-panel' },
] as const

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

test('Phase 5 四主题形成可辨识的大厅、牌桌动作与结算表现', async ({ page }) => {
  test.setTimeout(480_000)
  await mkdir(evidenceRoot, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })

  const lobbyFingerprints: string[] = []
  const seatFingerprints: string[] = []
  const settlementFingerprints: string[] = []

  for (const theme of phaseFiveThemes) {
    await page.goto(`/?theme=${theme.name}&winEffectLab=1&actionCueLab=peng&actionCueSeat=1`, { waitUntil: 'domcontentloaded' })
    const shell = page.locator('main.game-app')
    await expect(shell).toHaveAttribute('data-table-theme', theme.name)
    await expect(shell).toHaveAttribute('data-theme-player-frame', theme.frame)
    await expect(shell).toHaveAttribute('data-theme-loading', theme.loading)
    await expect(page.locator('.character-shortcut')).toHaveCount(theme.name === 'llmAnime' ? 1 : 0)

    lobbyFingerprints.push(await page.locator('.lobby').evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.backgroundColor}|${style.backgroundImage}`
    }))
    await page.locator('.win-effect-lab').evaluate((element: HTMLElement) => { element.style.visibility = 'hidden' })
    await page.screenshot({ path: `${evidenceRoot}/${theme.name}-lobby-1366x768.png` })

    await page.getByRole('button', { name: /开始东风场/ }).click()
    await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('.game-table-hud')).toHaveAttribute('data-table-theme', theme.name)
    if (theme.name === 'llmAnime') await expect(page.locator('.anime-action-cue')).toBeVisible()
    else await expect(page.locator('.table-action-cue')).toBeVisible()

    seatFingerprints.push(await page.locator('.seat-left .avatar-wrap').evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.borderRadius}|${style.borderColor}|${style.backgroundImage}|${style.boxShadow}`
    }))
    await page.screenshot({ path: `${evidenceRoot}/${theme.name}-table-action-1366x768.png` })

    await page.getByTestId('win-self-0').evaluate((element: HTMLElement) => element.click())
    await expect(page.locator('.settlement-card')).toBeVisible({ timeout: 45_000 })
    await page.waitForTimeout(600)
    settlementFingerprints.push(await page.locator('.settlement-card').evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.borderRadius}|${style.borderColor}|${style.backgroundColor}|${style.backgroundImage}|${style.boxShadow}`
    }))
    await page.screenshot({ path: `${evidenceRoot}/${theme.name}-settlement-1366x768.png` })
  }

  expect(new Set(lobbyFingerprints).size).toBe(phaseFiveThemes.length)
  expect(new Set(seatFingerprints).size).toBe(phaseFiveThemes.length)
  expect(new Set(settlementFingerprints).size).toBe(phaseFiveThemes.length)
})
