import { expect, test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

test('starts a local match and begins the opening deal', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: '莲花广麻' })).toBeVisible()
  await page.evaluate(() => {
    const target = window as unknown as { __openingDataStages?: string[] }
    target.__openingDataStages = []
    window.setInterval(() => {
      const stage = document.querySelector<HTMLElement>('.game-table-hud')?.dataset.openingStage
      if (stage && !target.__openingDataStages?.includes(stage)) target.__openingDataStages?.push(stage)
    }, 20)
  })
  await page.getByRole('button', { name: /开始东风场/ }).click()

  await expect(page.locator('.game-table-hud')).toBeVisible()
  // 3D 牌桌是按需加载的大模块；为低性能 CI Runner 留出独立加载窗口。
  await expect(page.locator('canvas.mahjong-scene')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('东风场 · 东1局', { exact: true }).first()).toBeVisible()
  await expect(page.locator('.player-seat')).toHaveCount(3)
  await expect.poll(
    () => page.locator('.hand-tile-slot').count(),
    { timeout: 30_000, message: 'opening timeline should deal the first local batch' },
  ).toBeGreaterThanOrEqual(4)
  const openingDataStages = await page.evaluate(() => (
    window as unknown as { __openingDataStages?: string[] }
  ).__openingDataStages ?? [])
  expect(openingDataStages).toEqual(expect.arrayContaining(['start', 'dice', 'deal']))
  await expect(page.locator('.game-table-hud')).toHaveAttribute('data-dice-values', /\d,\d/)
  await expect(page.locator('.game-table-hud')).toHaveAttribute('data-wall-count', /\d+/)

  expect(pageErrors).toEqual([])
})

test('runs the win presentation through reveal into settlement', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })

  await page.goto('/?winEffectLab=1')
  await expect(page.getByTestId('win-self-0')).toBeVisible()
  await page.evaluate(() => {
    const target = window as unknown as { __winEffectDataIds?: number[] }
    target.__winEffectDataIds = []
    window.setInterval(() => {
      const raw = document.querySelector<HTMLElement>('.game-table-hud')?.dataset.winEffectId
      const id = Number(raw)
      if (Number.isInteger(id) && id >= 0 && !target.__winEffectDataIds?.includes(id)) {
        target.__winEffectDataIds?.push(id)
      }
    }, 20)
  })
  await page.getByTestId('win-self-0').click()

  await expect(page.locator('.game-table-hud')).toBeVisible()
  await expect(page.locator('.round-settlement')).toBeVisible({ timeout: 8_000 })
  await expect(page.locator('.settlement-card .round-rankings article')).toHaveCount(4)
  await expect(page.locator('.settlement-card .horse-area .mahjong-tile')).toHaveCount(8)
  const winEffectDataIds = await page.evaluate(() => (
    window as unknown as { __winEffectDataIds?: number[] }
  ).__winEffectDataIds ?? [])
  expect(winEffectDataIds.length).toBeGreaterThan(0)
  expect(pageErrors).toEqual([])
})
