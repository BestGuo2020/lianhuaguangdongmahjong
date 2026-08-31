import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

test.describe.configure({ mode: 'serial' })

const evidenceRoot = 'test-results/responsive-r6'
const viewports = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x900', width: 1920, height: 900 },
  { name: '2560x1080', width: 2560, height: 1080 },
  { name: '844x390', width: 844, height: 390 },
  { name: '667x375', width: 667, height: 375 },
  { name: '568x320', width: 568, height: 320 },
] as const

const themes = ['jade', 'majsoul', 'happyMahjong', 'rosewood', 'llm', 'llmAnime'] as const

type Rect = { x: number; y: number; width: number; height: number; right: number; bottom: number }

function overlap(a: Rect | null, b: Rect | null) {
  if (!a || !b) return 0
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y))
}

async function hideWinLab(page: Page) {
  await page.addStyleTag({ content: '.win-effect-lab{display:none!important}' })
}

async function startMatch(page: Page, theme: string, debugWin = false, cameraLab = false) {
  const query = new URLSearchParams({ theme, actionCueLab: 'peng', actionCueSeat: '1' })
  if (debugWin) query.set('winEffectLab', '1')
  if (cameraLab) query.set('cameraLab', '1')
  await page.goto(`/?${query}`, { waitUntil: 'domcontentloaded' })
  if (debugWin) await hideWinLab(page)
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.game-table-hud')).toBeVisible()
  await expect(page.locator('canvas.mahjong-scene')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
}

async function assertTableLayout(page: Page, viewport: typeof viewports[number]) {
  const metrics = await page.evaluate(() => {
    const rect = (selector: string) => {
      const value = document.querySelector(selector)?.getBoundingClientRect()
      return value ? {
        x: value.x, y: value.y, width: value.width, height: value.height,
        right: value.right, bottom: value.bottom,
      } : null
    }
    const targets = [...document.querySelectorAll<HTMLElement>('.top-bar button,.action,.hand-tile-slot')]
      .map((element) => element.getBoundingClientRect())
    return {
      game: rect('.game-app'),
      canvas: rect('canvas.mahjong-scene'),
      topbar: rect('.top-bar'),
      topSeat: rect('.seat-top .avatar-wrap'),
      hand: rect('.hand-rack'),
      cue: rect('.anime-action-cue,.table-action-cue'),
      artRatio: (() => {
        const cue = document.querySelector('.anime-action-cue')?.getBoundingClientRect()
        const art = document.querySelector('.anime-action-cue img.dedicated-action-art')?.getBoundingClientRect()
        return cue && art ? { width: art.width / cue.width, height: art.height / cue.height } : null
      })(),
      minTarget: targets.length ? {
        width: Math.min(...targets.map((value) => value.width)),
        height: Math.min(...targets.map((value) => value.height)),
      } : null,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      overflowY: document.documentElement.scrollHeight - window.innerHeight,
    }
  })

  expect(metrics.game?.x).toBeCloseTo(0, 0)
  expect(metrics.game?.y).toBeCloseTo(0, 0)
  expect(metrics.game?.width).toBeCloseTo(viewport.width, 0)
  expect(metrics.game?.height).toBeCloseTo(viewport.height, 0)
  expect(metrics.canvas?.width).toBeCloseTo(metrics.game!.width, 0)
  expect(metrics.canvas?.height).toBeCloseTo(metrics.game!.height, 0)
  expect(metrics.overflowX).toBe(0)
  expect(metrics.overflowY).toBe(0)
  expect(overlap(metrics.topbar, metrics.topSeat)).toBe(0)
  expect(overlap(metrics.hand, metrics.cue)).toBe(0)

  if (viewport.width <= 844 && viewport.height <= 390) {
    expect(metrics.minTarget?.width).toBeGreaterThanOrEqual(43.5)
    expect(metrics.minTarget?.height).toBeGreaterThanOrEqual(43.5)
  }
  if (metrics.artRatio) {
    const expectedScale = viewport.width <= 760 || (viewport.width <= 1000 && viewport.height <= 520 && viewport.width / viewport.height >= 2)
      ? 1.15
      : 2
    expect(metrics.artRatio.width).toBeCloseTo(expectedScale, 1)
    expect(metrics.artRatio.height).toBeCloseTo(expectedScale, 1)
  }
}

async function showDebugSettlement(page: Page) {
  await page.getByTestId('win-self-0').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.round-settlement')).toBeVisible({ timeout: 45_000 })
}

test('jade 与 llmAnime 覆盖 §15.5 全视口正常牌桌矩阵', async ({ page }) => {
  test.setTimeout(180_000)
  await mkdir(`${evidenceRoot}/viewport-table`, { recursive: true })

  for (const theme of ['jade', 'llmAnime'] as const) {
    await page.setViewportSize({ width: 1366, height: 768 })
    await startMatch(page, theme)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      await assertTableLayout(page, viewport)
      await page.screenshot({ path: `${evidenceRoot}/viewport-table/${theme}-${viewport.name}.png` })
    }
  }
})

test('jade 与 llmAnime 覆盖 §15.5 全视口滚动结算矩阵', async ({ page }) => {
  test.setTimeout(180_000)
  await mkdir(`${evidenceRoot}/viewport-settlement`, { recursive: true })

  for (const theme of ['jade', 'llmAnime'] as const) {
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto(`/?theme=${theme}&winEffectLab=1`, { waitUntil: 'domcontentloaded' })
    await showDebugSettlement(page)
    await hideWinLab(page)

    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      const metrics = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>('.settlement-card')!
        const footer = document.querySelector<HTMLElement>('.settlement-footer')!
        const buttonRects = [...footer.querySelectorAll('button')].map((button) => button.getBoundingClientRect())
        const cardRect = card.getBoundingClientRect()
        const footerRect = footer.getBoundingClientRect()
        return {
          card: { top: cardRect.top, right: cardRect.right, bottom: cardRect.bottom, left: cardRect.left },
          footer: { top: footerRect.top, right: footerRect.right, bottom: footerRect.bottom, left: footerRect.left },
          overflowY: getComputedStyle(card).overflowY,
          minButtonHeight: Math.min(...buttonRects.map((value) => value.height)),
        }
      })
      expect(metrics.card.top).toBeGreaterThanOrEqual(-0.5)
      expect(metrics.card.left).toBeGreaterThanOrEqual(-0.5)
      expect(metrics.card.right).toBeLessThanOrEqual(viewport.width + 0.5)
      expect(metrics.card.bottom).toBeLessThanOrEqual(viewport.height + 0.5)
      expect(metrics.footer.bottom).toBeLessThanOrEqual(viewport.height + 0.5)
      expect(metrics.minButtonHeight).toBeGreaterThanOrEqual(43.5)
      if (viewport.height <= 390) expect(metrics.overflowY).toBe('auto')
      await page.screenshot({ path: `${evidenceRoot}/viewport-settlement/${theme}-${viewport.name}.png` })
    }
  }
})

test('六主题在共享 1366×768 布局完成正常对局与结算回归', async ({ page }) => {
  test.setTimeout(300_000)
  await mkdir(`${evidenceRoot}/themes`, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })

  for (const theme of themes) {
    await startMatch(page, theme, true)
    await assertTableLayout(page, { name: '1366x768', width: 1366, height: 768 })
    await page.screenshot({ path: `${evidenceRoot}/themes/${theme}-game.png` })
    await showDebugSettlement(page)
    await page.screenshot({ path: `${evidenceRoot}/themes/${theme}-settlement.png` })
  }
})

test('568×320 菜单/规则与 667×375 翻精面板均钳制在安全区', async ({ page }) => {
  test.setTimeout(90_000)
  await mkdir(`${evidenceRoot}/extreme`, { recursive: true })
  await page.setViewportSize({ width: 568, height: 320 })
  await page.goto('/?theme=jade', { waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: '切换牌桌主题' }).click()
  await expect(page.locator('.theme-menu')).toBeVisible()
  const menu = await page.locator('.theme-menu').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }
  })
  expect(menu.top).toBeGreaterThanOrEqual(0)
  expect(menu.right).toBeLessThanOrEqual(568)
  expect(menu.bottom).toBeLessThanOrEqual(320)
  expect(menu.left).toBeGreaterThanOrEqual(0)
  await page.screenshot({ path: `${evidenceRoot}/extreme/jade-568x320-theme-menu.png` })

  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '游戏规则 →' }).click()
  await expect(page.locator('.rules-panel')).toBeVisible()
  await page.waitForTimeout(350)
  const rules = await page.locator('.rules-panel').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, scrollable: element.scrollHeight > element.clientHeight }
  })
  expect(rules.top).toBeGreaterThanOrEqual(-0.5)
  expect(rules.right).toBeLessThanOrEqual(569)
  expect(rules.bottom).toBeLessThanOrEqual(320.5)
  expect(rules.scrollable).toBe(true)
  expect(rules.left).toBeGreaterThanOrEqual(0)
  await page.screenshot({ path: `${evidenceRoot}/extreme/jade-568x320-rules.png` })

  await page.getByRole('button', { name: '关闭规则' }).click()
  await page.setViewportSize({ width: 667, height: 375 })
  await page.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  await page.getByRole('button', { name: /莲花麻将 翻精癞子/ }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.flip-indicator')).toBeVisible({ timeout: 30_000 })
  const overlapArea = await page.evaluate(() => {
    const rect = (selector: string) => {
      const value = document.querySelector(selector)?.getBoundingClientRect()
      return value ? { x: value.x, y: value.y, right: value.right, bottom: value.bottom } : null
    }
    const intersect = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => !a || !b ? 0
      : Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y))
    return {
      topSeat: intersect(rect('.flip-indicator'), rect('.seat-top .avatar-wrap')),
      topbar: intersect(rect('.flip-indicator'), rect('.top-bar')),
    }
  })
  expect(overlapArea).toEqual({ topSeat: 0, topbar: 0 })
  await page.screenshot({ path: `${evidenceRoot}/extreme/jade-667x375-flip.png` })
})

test('llmAnime 移动端菜单沿用共享版式且顶栏按钮视觉缩小', async ({ page }) => {
  test.setTimeout(60_000)
  await mkdir(`${evidenceRoot}/extreme`, { recursive: true })
  await page.setViewportSize({ width: 896, height: 414 })
  await page.goto('/?theme=llmAnime', { waitUntil: 'domcontentloaded' })

  const themeTrigger = page.getByRole('button', { name: '切换牌桌主题' })
  await themeTrigger.click()
  await expect(page.locator('.theme-menu')).toBeVisible()
  const themeMetrics = await page.evaluate(() => {
    const trigger = document.querySelector<HTMLElement>('.theme-toggle')!
    const triggerRect = trigger.getBoundingClientRect()
    const triggerFace = getComputedStyle(trigger, '::before')
    const menu = document.querySelector<HTMLElement>('.theme-menu')!
    const menuRect = menu.getBoundingClientRect()
    const inactive = menu.querySelector<HTMLElement>('button:not(.active)')!
    const inactiveStyle = getComputedStyle(inactive)
    const rowHeights = [...menu.querySelectorAll('button')].map((button) => button.getBoundingClientRect().height)
    return {
      trigger: { width: triggerRect.width, height: triggerRect.height },
      face: { width: Number.parseFloat(triggerFace.width), height: Number.parseFloat(triggerFace.height) },
      menu: { top: menuRect.top, right: menuRect.right, bottom: menuRect.bottom, left: menuRect.left },
      inactive: { backgroundImage: inactiveStyle.backgroundImage, backgroundColor: inactiveStyle.backgroundColor },
      maximumRowHeight: Math.max(...rowHeights),
    }
  })
  expect(themeMetrics.trigger).toEqual({ width: 44, height: 44 })
  expect(themeMetrics.face.width).toBeCloseTo(36, 0)
  expect(themeMetrics.face.height).toBeCloseTo(36, 0)
  expect(themeMetrics.menu.left).toBeGreaterThanOrEqual(0)
  expect(themeMetrics.menu.right).toBeLessThanOrEqual(896)
  expect(themeMetrics.menu.bottom).toBeLessThanOrEqual(414)
  expect(themeMetrics.inactive.backgroundImage).toBe('none')
  expect(themeMetrics.inactive.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(themeMetrics.maximumRowHeight).toBeLessThanOrEqual(50)
  await page.screenshot({ path: `${evidenceRoot}/extreme/llmAnime-896x414-theme-menu.png` })

  await themeTrigger.click()
  await page.getByRole('button', { name: '声音设置' }).click()
  await expect(page.locator('.audio-menu')).toBeVisible()
  const audioMetrics = await page.locator('.audio-menu').evaluate((menu) => {
    const rect = menu.getBoundingClientRect()
    const buttons = [...menu.querySelectorAll('button')]
    const firstStyle = getComputedStyle(buttons[0]!)
    return {
      rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
      maximumRowHeight: Math.max(...buttons.map((button) => button.getBoundingClientRect().height)),
      backgroundImage: firstStyle.backgroundImage,
      backgroundColor: firstStyle.backgroundColor,
    }
  })
  expect(audioMetrics.rect.left).toBeGreaterThanOrEqual(0)
  expect(audioMetrics.rect.right).toBeLessThanOrEqual(896)
  expect(audioMetrics.rect.bottom).toBeLessThanOrEqual(414)
  expect(audioMetrics.maximumRowHeight).toBeLessThanOrEqual(56)
  expect(audioMetrics.backgroundImage).toBe('none')
  expect(audioMetrics.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ path: `${evidenceRoot}/extreme/llmAnime-896x414-audio-menu.png` })
})

test('所有主题的小横屏玩家名统一完整换行显示', async ({ page }) => {
  test.setTimeout(90_000)
  await mkdir(`${evidenceRoot}/extreme`, { recursive: true })
  await page.addInitScript(() => {
    localStorage.setItem('llm.providers', JSON.stringify({
      configVersion: 2,
      enabled: true,
      presets: [{
        id: 'responsive-long-name',
        name: 'claude',
        providerType: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'e2e-placeholder',
        model: 'deepseek-chat',
        style: '话痨',
        timeoutMs: 20_000,
      }],
      activeId: 'responsive-long-name',
      seatIds: [null, null, null, null],
      seatStyles: [null, '话痨', '话痨', '话痨'],
    }))
  })
  await page.setViewportSize({ width: 896, height: 414 })
  for (const theme of ['rosewood', 'llmAnime'] as const) {
    await startMatch(page, theme)
    const names = await page.locator('.player-seat .player-info strong').evaluateAll((elements) => elements.map((element) => {
      const node = element as HTMLElement
      const style = getComputedStyle(node)
      return {
        text: node.textContent ?? '',
        clientWidth: node.clientWidth,
        clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth,
        scrollHeight: node.scrollHeight,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      }
    }))
    expect(names).toHaveLength(3)
    for (const name of names) {
      expect(name.text).toContain('（话痨）')
      expect(name.textOverflow).toBe('clip')
      expect(name.whiteSpace).toBe('normal')
      expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1)
      expect(name.scrollHeight).toBeLessThanOrEqual(name.clientHeight + 1)
    }
    await page.screenshot({ path: `${evidenceRoot}/extreme/${theme}-896x414-long-player-names.png` })
  }
})

test('平板横屏矩阵保持完整桌面视野与统一玩家名布局', async ({ browser }) => {
  test.setTimeout(150_000)
  await mkdir(`${evidenceRoot}/tablet`, { recursive: true })
  const port = Number(process.env.E2E_PORT || 4173)
  const context = await browser.newContext({
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    localStorage.setItem('llm.providers', JSON.stringify({
      configVersion: 2,
      enabled: true,
      presets: [{
        id: 'tablet-long-name',
        name: 'claude',
        providerType: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'e2e-placeholder',
        model: 'deepseek-chat',
        style: '话痨',
        timeoutMs: 20_000,
      }],
      activeId: 'tablet-long-name',
      seatIds: [null, null, null, null],
      seatStyles: [null, '话痨', '话痨', '话痨'],
    }))
  })
  await startMatch(page, 'rosewood', false, true)

  const tablets = [
    { name: 'ipad-mini', width: 1024, height: 768 },
    { name: 'ipad-air', width: 1180, height: 820 },
    { name: 'ipad-pro', width: 1366, height: 1024 },
    { name: 'surface-pro-7', width: 1368, height: 912 },
    { name: 'zenbook-fold', width: 1280, height: 853 },
  ]
  for (const tablet of tablets) {
    await page.setViewportSize(tablet)
    await page.waitForTimeout(250)
    const metrics = await page.evaluate(() => {
      const game = document.querySelector('.game-app')!.getBoundingClientRect()
      const canvas = document.querySelector('canvas.mahjong-scene')!.getBoundingClientRect()
      const topSeat = document.querySelector('.seat-top .avatar-wrap')!.getBoundingClientRect()
      const rightSeat = document.querySelector('.seat-right .avatar-wrap')!.getBoundingClientRect()
      const names = [...document.querySelectorAll<HTMLElement>('.player-seat .player-info strong')].map((node) => ({
        text: node.textContent ?? '',
        clientWidth: node.clientWidth,
        clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth,
        scrollHeight: node.scrollHeight,
        whiteSpace: getComputedStyle(node).whiteSpace,
      }))
      const overlap = Math.max(0, Math.min(topSeat.right, rightSeat.right) - Math.max(topSeat.left, rightSeat.left))
        * Math.max(0, Math.min(topSeat.bottom, rightSeat.bottom) - Math.max(topSeat.top, rightSeat.top))
      return {
        viewport: { width: innerWidth, height: innerHeight },
        game: { width: game.width, height: game.height },
        canvas: { width: canvas.width, height: canvas.height },
        cameraFov: Number(document.querySelector('canvas.mahjong-scene')?.getAttribute('data-camera-fov')),
        coarsePointer: matchMedia('(hover: none) and (pointer: coarse)').matches,
        topSeatLeftRatio: topSeat.left / innerWidth,
        topRightOverlap: overlap,
        names,
      }
    })
    expect(metrics.viewport).toEqual({ width: tablet.width, height: tablet.height })
    expect(metrics.game.width).toBeCloseTo(tablet.width, 0)
    expect(metrics.game.height).toBeCloseTo(tablet.height, 0)
    expect(metrics.canvas).toEqual(metrics.game)
    expect(metrics.cameraFov).toBeGreaterThan(39)
    expect(metrics.cameraFov).toBeLessThan(52)
    expect(metrics.coarsePointer).toBe(true)
    expect(metrics.topSeatLeftRatio).toBeGreaterThanOrEqual(.8)
    expect(metrics.topRightOverlap).toBe(0)
    for (const name of metrics.names) {
      expect(name.text).toContain('（话痨）')
      expect(name.whiteSpace).toBe('normal')
      expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1)
      expect(name.scrollHeight).toBeLessThanOrEqual(name.clientHeight + 1)
    }
    await page.screenshot({ path: `${evidenceRoot}/tablet/rosewood-${tablet.name}-${tablet.width}x${tablet.height}.png` })
  }
  await context.close()
})

test('摸打阶段相机固定，胡牌 shake 结束后精确复原', async ({ page }) => {
  test.setTimeout(90_000)
  await mkdir(`${evidenceRoot}/camera`, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await startMatch(page, 'jade', true, true)
  const canvas = page.locator('canvas.mahjong-scene')
  await expect(canvas).toHaveAttribute('data-camera-position', /.+/)

  const sampleCamera = async (count: number, intervalMs: number) => {
    const samples: string[] = []
    for (let index = 0; index < count; index += 1) {
      samples.push((await canvas.getAttribute('data-camera-position')) ?? '')
      await page.waitForTimeout(intervalMs)
    }
    return samples
  }

  const idleSamples = await sampleCamera(6, 60)
  expect(new Set(idleSamples)).toEqual(new Set(['0.000000,17.200000,11.800000']))

  await page.getByTestId('win-self-0').evaluate((element: HTMLElement) => element.click())
  await expect.poll(async () => Number(await page.locator('.game-table-hud').getAttribute('data-win-effect-id')), {
    timeout: 5_000,
  }).toBeGreaterThan(0)
  await page.waitForTimeout(200)
  const shakeSamples = await sampleCamera(8, 45)
  expect(shakeSamples).toHaveLength(8)

  await page.waitForTimeout(2_600)
  const restoredSamples = await sampleCamera(5, 60)
  expect(new Set(restoredSamples)).toEqual(new Set(['0.000000,17.200000,11.800000']))
  await page.screenshot({ path: `${evidenceRoot}/camera/jade-1366x768-restored.png` })
})

test('896×414 下对家避开中央牌河且本家牌保持麻将比例', async ({ page }) => {
  test.setTimeout(60_000)
  await mkdir(`${evidenceRoot}/extreme`, { recursive: true })
  await page.setViewportSize({ width: 896, height: 414 })
  await startMatch(page, 'llm')
  await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(13)

  const metrics = await page.evaluate(() => {
    const topSeat = document.querySelector('.seat-top .avatar-wrap')!.getBoundingClientRect()
    const rightSeat = document.querySelector('.seat-right .avatar-wrap')!.getBoundingClientRect()
    const slot = document.querySelector('.hand-tile-slot')!.getBoundingClientRect()
    const tileRects = [...document.querySelectorAll('.hand-rack .mahjong-tile')]
      .map((element) => element.getBoundingClientRect())
      .sort((left, right) => left.left - right.left)
    const tile = tileRects[0]!
    const minimumTileGap = Math.min(...tileRects.slice(1).map((rect, index) => rect.left - tileRects[index]!.right))
    const overlap = Math.max(0, Math.min(topSeat.right, rightSeat.right) - Math.max(topSeat.left, rightSeat.left))
      * Math.max(0, Math.min(topSeat.bottom, rightSeat.bottom) - Math.max(topSeat.top, rightSeat.top))
    return {
      topSeatLeftRatio: topSeat.left / window.innerWidth,
      topRightOverlap: overlap,
      slot: { width: slot.width, height: slot.height },
      tile: { width: tile.width, height: tile.height, aspect: tile.width / tile.height },
      minimumTileGap,
    }
  })

  expect(metrics.topSeatLeftRatio).toBeGreaterThanOrEqual(.78)
  expect(metrics.topRightOverlap).toBe(0)
  expect(metrics.slot.width).toBeGreaterThanOrEqual(43.5)
  expect(metrics.slot.height).toBeGreaterThanOrEqual(43.5)
  expect(metrics.tile.width).toBeGreaterThanOrEqual(36)
  expect(metrics.tile.width).toBeLessThanOrEqual(40.5)
  expect(metrics.tile.aspect).toBeCloseTo(.8, 2)
  expect(metrics.minimumTileGap).toBeGreaterThanOrEqual(0)
  await page.screenshot({ path: `${evidenceRoot}/extreme/llm-896x414-game.png` })
})

test('896×414 左右家气泡位于头像下方且尾巴朝上', async ({ page }) => {
  test.setTimeout(60_000)
  await mkdir(`${evidenceRoot}/extreme`, { recursive: true })
  await page.setViewportSize({ width: 896, height: 414 })
  await page.goto('/?theme=llm&bubbleLab=1', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.seat-left .llm-bubble')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.seat-right .llm-bubble')).toBeVisible({ timeout: 30_000 })

  const metrics = await page.evaluate(() => {
    const measure = (seatSelector: string, bubbleSelector: string) => {
      const seat = document.querySelector(seatSelector)!.getBoundingClientRect()
      const bubble = document.querySelector(bubbleSelector)!.getBoundingClientRect()
      const tail = getComputedStyle(document.querySelector(bubbleSelector)!, '::after')
      return {
        seatBottom: seat.bottom,
        bubble: { left: bubble.left, top: bubble.top, right: bubble.right, bottom: bubble.bottom },
        tailTop: Number.parseFloat(tail.top),
        tailTransform: tail.transform,
      }
    }
    return {
      left: measure('.seat-left .avatar-wrap', '.seat-left .llm-bubble'),
      right: measure('.seat-right .avatar-wrap', '.seat-right .llm-bubble'),
    }
  })

  for (const side of [metrics.left, metrics.right]) {
    expect(side.bubble.left).toBeGreaterThanOrEqual(0)
    expect(side.bubble.right).toBeLessThanOrEqual(896)
    expect(side.bubble.top).toBeGreaterThanOrEqual(side.seatBottom + 4)
    expect(side.tailTop).toBeLessThan(0)
    expect(side.tailTransform).not.toBe('none')
  }
  await page.screenshot({ path: `${evidenceRoot}/extreme/llm-896x414-bubbles.png` })
})

test('reduced motion 下胡牌立绘仍先于 Three.js 光效退出', async ({ page }) => {
  test.setTimeout(60_000)
  await mkdir(`${evidenceRoot}/reduced-motion`, { recursive: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 667, height: 375 })
  await page.goto('/?theme=llmAnime&winEffectLab=1', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('win-self-0').evaluate((element: HTMLElement) => element.click())
  await page.waitForTimeout(20)
  const cueStage = await page.locator('.game-table-hud').evaluate((hud) => ({
    effectId: Number(hud.getAttribute('data-win-effect-id')),
    cueVisible: Boolean(document.querySelector('.anime-action-cue')),
  }))
  expect(cueStage).toEqual({ effectId: -1, cueVisible: true })
  await page.screenshot({ path: `${evidenceRoot}/reduced-motion/llmAnime-667x375-cue.png` })

  await page.waitForTimeout(460)
  const effectStage = await page.locator('.game-table-hud').evaluate((hud) => {
    const cue = document.querySelector<HTMLElement>('.anime-action-cue')
    return {
      effectId: Number(hud.getAttribute('data-win-effect-id')),
      cueOpacity: cue ? Number(getComputedStyle(cue).opacity) : 0,
    }
  })
  expect(effectStage.effectId).toBeGreaterThan(0)
  expect(effectStage.cueOpacity).toBe(0)
  await page.screenshot({ path: `${evidenceRoot}/reduced-motion/llmAnime-667x375-effect.png` })
})
