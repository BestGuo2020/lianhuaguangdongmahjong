import { expect, test, type Browser, type Page } from '@playwright/test'
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

const phoneLandscapeViewports = [
  { name: 'iphone-se', width: 667, height: 375 },
  { name: 'iphone-x', width: 812, height: 375 },
  { name: 'iphone-mainstream', width: 844, height: 390 },
  { name: 'iphone-pro', width: 852, height: 393 },
  { name: 'iphone-plus', width: 926, height: 428 },
  { name: 'iphone-pro-max', width: 932, height: 430 },
  { name: 'android-mainstream', width: 800, height: 360 },
  { name: 'android-large', width: 915, height: 412 },
  { name: 'android-legacy', width: 640, height: 360 },
  { name: 'android-18x9', width: 720, height: 360 },
] as const

const desktopViewports = [
  { name: 'window-1280x720', width: 1280, height: 720 },
  { name: 'laptop-1366x768', width: 1366, height: 768 },
  { name: 'full-hd', width: 1920, height: 1080 },
  { name: 'qhd', width: 2560, height: 1440 },
  { name: 'ultrawide', width: 3440, height: 1440 },
  { name: '4k-css', width: 3840, height: 2160 },
] as const

type Rect = { x: number; y: number; width: number; height: number; right: number; bottom: number }

async function createTouchPage(browser: Browser, width: number, height: number) {
  const port = Number(process.env.E2E_PORT || 4173)
  const context = await browser.newContext({
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
  })
  return { context, page: await context.newPage() }
}

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
      coarsePointer: matchMedia('(hover: none) and (pointer: coarse)').matches,
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
    const expectedScale = metrics.coarsePointer ? 1.15 : 2
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

test('568×320 菜单/规则与 667×375 翻精面板均钳制在安全区', async ({ browser }) => {
  test.setTimeout(90_000)
  await mkdir(`${evidenceRoot}/extreme`, { recursive: true })
  const { context, page } = await createTouchPage(browser, 568, 320)
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
  await context.close()
})

test('llmAnime 移动端菜单沿用共享版式且顶栏按钮视觉缩小', async ({ browser }) => {
  test.setTimeout(60_000)
  await mkdir(`${evidenceRoot}/extreme`, { recursive: true })
  const { context, page } = await createTouchPage(browser, 896, 414)
  await page.goto('/?theme=llmAnime', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.top-bar .brand-mini')).toHaveCount(0)
  await expect(page.locator('.top-bar .round-info')).toHaveCount(0)

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
  expect(themeMetrics.face.width).toBeCloseTo(32, 0)
  expect(themeMetrics.face.height).toBeCloseTo(32, 0)
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

  await page.goto('/?theme=jade', { waitUntil: 'domcontentloaded' })
  const sharedControlMetrics = await page.evaluate(() => {
    const trigger = document.querySelector<HTMLElement>('.theme-toggle')!
    const face = getComputedStyle(trigger, '::before')
    const controls = [...document.querySelectorAll<HTMLElement>('.topbar-control')].map((element) => element.getBoundingClientRect())
    const icons = [...document.querySelectorAll<HTMLImageElement>('.topbar-control img')].map((element) => element.getBoundingClientRect())
    return {
      hit: {
        width: Math.min(...controls.map((value) => value.width)),
        height: Math.min(...controls.map((value) => value.height)),
      },
      themeFace: { width: Number.parseFloat(face.width), height: Number.parseFloat(face.height) },
      iconMaximum: Math.max(...icons.flatMap((value) => [value.width, value.height])),
    }
  })
  expect(sharedControlMetrics.hit).toEqual({ width: 44, height: 44 })
  expect(sharedControlMetrics.themeFace.width).toBeCloseTo(32, 0)
  expect(sharedControlMetrics.themeFace.height).toBeCloseTo(32, 0)
  expect(sharedControlMetrics.iconMaximum).toBeLessThanOrEqual(28.5)
  await page.screenshot({ path: `${evidenceRoot}/extreme/jade-896x414-compact-topbar-controls.png` })
  await context.close()
})

test('所有主题的小横屏玩家名统一单行省略显示', async ({ browser }) => {
  test.setTimeout(180_000)
  await mkdir(`${evidenceRoot}/extreme`, { recursive: true })
  const { context, page } = await createTouchPage(browser, 896, 414)
  await page.addInitScript(() => {
    localStorage.setItem('llm.providers', JSON.stringify({
      configVersion: 2,
      enabled: true,
      presets: [{
        id: 'responsive-long-name',
        name: 'claude',
        nickname: '克劳德书姬',
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
      expect(name.textOverflow).toBe('ellipsis')
      expect(name.whiteSpace).toBe('nowrap')
      expect(name.scrollWidth).toBeGreaterThan(name.clientWidth)
      expect(name.scrollHeight).toBeLessThanOrEqual(name.clientHeight + 1)
    }
    await page.screenshot({ path: `${evidenceRoot}/extreme/${theme}-896x414-long-player-names.png` })
  }
  await context.close()
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
        nickname: '克劳德书姬',
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
  await page.waitForSelector('.hand-rack .mahjong-tile', { timeout: 30_000 })

  const tablets = [
    { name: 'ipad-mini', width: 1024, height: 768 },
    { name: 'ipad-air', width: 1180, height: 820 },
    { name: 'ipad-pro-11', width: 1194, height: 834 },
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
        handTileWidth: (document.querySelector('.hand-rack .mahjong-tile') as HTMLElement | null)?.getBoundingClientRect().width ?? 0,
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
    // 平板（≥1024×768）切回 PC 样式：对家回到 50%+偏移 的桌面锚点（约 0.65~0.68），不再右移到 86%
    expect(metrics.topSeatLeftRatio).toBeGreaterThanOrEqual(.6)
    expect(metrics.topSeatLeftRatio).toBeLessThanOrEqual(.75)
    expect(metrics.topRightOverlap).toBe(0)
    expect(metrics.handTileWidth).toBeGreaterThanOrEqual(55) // 平板手牌接近 PC 尺寸，不再 40px
    for (const name of metrics.names) {
      expect(name.text).toContain('（话痨）')
      expect(name.whiteSpace).toBe('nowrap')
      expect(name.scrollWidth).toBeGreaterThan(name.clientWidth)
      expect(name.scrollHeight).toBeLessThanOrEqual(name.clientHeight + 1)
    }
    await page.screenshot({ path: `${evidenceRoot}/tablet/rosewood-${tablet.name}-${tablet.width}x${tablet.height}.png` })
  }
  await context.close()
})

test('手机横屏清单使用同一触控布局连续适配', async ({ browser }) => {
  test.setTimeout(180_000)
  await mkdir(`${evidenceRoot}/phone-matrix`, { recursive: true })
  const initial = phoneLandscapeViewports[0]
  const { context, page } = await createTouchPage(browser, initial.width, initial.height)
  await startMatch(page, 'llmAnime', false, true)
  await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(13)

  for (const viewport of phoneLandscapeViewports) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(180)
    const metrics = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? null
      const overlap = (left: DOMRect | null, right: DOMRect | null) => !left || !right ? 0
        : Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
          * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
      const game = rect('.game-app')!
      const canvas = rect('canvas.mahjong-scene')!
      const topSeat = rect('.seat-top .avatar-wrap')!
      const rightSeat = rect('.seat-right .avatar-wrap')!
      const topbar = rect('.top-bar')!
      const tileRects = [...document.querySelectorAll('.hand-rack .mahjong-tile')]
        .map((element) => element.getBoundingClientRect())
        .sort((a, b) => a.left - b.left)
      const minimumTileGap = tileRects.length > 1
        ? Math.min(...tileRects.slice(1).map((value, index) => value.left - tileRects[index]!.right))
        : 0
      const controls = [...document.querySelectorAll<HTMLElement>('.topbar-control')]
        .map((element) => element.getBoundingClientRect())
      const handHitAreas = [...document.querySelectorAll<HTMLElement>('.hand-hit-area')]
        .map((element) => element.getBoundingClientRect())
      const seatCardElements = [
        ...document.querySelectorAll<HTMLElement>('.player-seat .avatar-wrap'),
        document.querySelector<HTMLElement>('.user-identity')!,
      ]
      const seatCards = seatCardElements.map((element) => element.getBoundingClientRect())
      const mobileNames = seatCardElements.map((element) => {
        const name = element.querySelector<HTMLElement>('.player-info strong')!
        const style = getComputedStyle(name)
        return {
          whiteSpace: style.whiteSpace,
          textOverflow: style.textOverflow,
          lineHeight: style.lineHeight,
          clientHeight: name.clientHeight,
          scrollHeight: name.scrollHeight,
        }
      })
      const scoreBottomInsets = seatCardElements.map((element, index) => {
        const score = element.querySelector('.player-info span')!.getBoundingClientRect()
        return seatCards[index]!.bottom - score.bottom
      })
      const scoreCenterOffsets = seatCardElements.map((element, index) => {
        const score = element.querySelector('.player-info span')!.getBoundingClientRect()
        const card = seatCards[index]!
        return Math.abs((score.left + score.right) / 2 - (card.left + card.right) / 2)
      })
      const actionCue = document.querySelector('.anime-action-cue')?.getBoundingClientRect()
      const actionArt = document.querySelector('.anime-action-cue img.dedicated-action-art')?.getBoundingClientRect()
      const slots = [...document.querySelectorAll<HTMLElement>('.hand-rack .hand-tile-slot')]
      const originalDrawnIndex = slots.findIndex((slot) => slot.classList.contains('drawn'))
      const semanticDrawGaps = [2, 5, 8, 11, 14]
        .filter((position) => position <= slots.length)
        .map((position) => {
          slots.forEach((slot) => slot.classList.remove('drawn'))
          const previousWithoutGap = slots[position - 2]!.querySelector<HTMLElement>('.mahjong-tile')!.getBoundingClientRect()
          const currentWithoutGap = slots[position - 1]!.querySelector<HTMLElement>('.mahjong-tile')!.getBoundingClientRect()
          const baseGap = currentWithoutGap.left - previousWithoutGap.right
          slots[position - 1]!.classList.add('drawn')
          const previous = slots[position - 2]!.querySelector<HTMLElement>('.mahjong-tile')!.getBoundingClientRect()
          const current = slots[position - 1]!.querySelector<HTMLElement>('.mahjong-tile')!.getBoundingClientRect()
          const gap = current.left - previous.right
          return { position, baseGap, gap, extraGap: gap - baseGap }
        })
      slots.forEach((slot, index) => slot.classList.toggle('drawn', index === originalDrawnIndex))
      return {
        viewport: { width: innerWidth, height: innerHeight },
        game: { width: game.width, height: game.height },
        canvas: { width: canvas.width, height: canvas.height },
        overflow: { x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight },
        coarsePrimary: matchMedia('(hover: none) and (pointer: coarse)').matches,
        coarseCapability: matchMedia('(any-pointer: coarse)').matches,
        safeTop: getComputedStyle(document.querySelector('.game-app')!).getPropertyValue('--safe-top').trim(),
        topbarTop: topbar.top,
        topbarOverlap: overlap(topSeat, topbar),
        topRightOverlap: overlap(topSeat, rightSeat),
        minimumTileGap,
        cssHandGap: getComputedStyle(document.querySelector('.hand-rack')!).gap,
        cssSlotWidth: getComputedStyle(document.querySelector('.hand-tile-slot')!).width,
        cssTileWidth: getComputedStyle(document.querySelector('.hand-rack .mahjong-tile')!).width,
        minimumControl: {
          width: Math.min(...controls.map((value) => value.width)),
          height: Math.min(...controls.map((value) => value.height)),
        },
        minimumHandHit: {
          width: Math.min(...handHitAreas.map((value) => value.width)),
          height: Math.min(...handHitAreas.map((value) => value.height)),
        },
        seatCardSpread: {
          width: Math.max(...seatCards.map((value) => value.width)) - Math.min(...seatCards.map((value) => value.width)),
          height: Math.max(...seatCards.map((value) => value.height)) - Math.min(...seatCards.map((value) => value.height)),
        },
        seatCardCssSizes: seatCardElements.map((element) => {
          const style = getComputedStyle(element)
          return `${style.width}x${style.height}`
        }),
        scoreBottomInsets,
        scoreCenterOffsets,
        mobileNames,
        semanticDrawGaps,
        actionArtRatio: actionCue && actionArt ? actionArt.width / actionCue.width : null,
      }
    })
    expect(metrics.viewport).toEqual({ width: viewport.width, height: viewport.height })
    expect(metrics.game).toEqual(metrics.canvas)
    expect(metrics.game.width).toBeCloseTo(viewport.width, 0)
    expect(metrics.game.height).toBeCloseTo(viewport.height, 0)
    expect(metrics.overflow).toEqual({ x: 0, y: 0 })
    expect(metrics.coarsePrimary).toBe(true)
    expect(metrics.coarseCapability).toBe(true)
    expect(metrics.safeTop).toBe('0px')
    expect(metrics.topbarTop).toBeCloseTo(0, 1)
    expect(metrics.topbarOverlap).toBe(0)
    expect(metrics.topRightOverlap).toBe(0)
    expect(metrics.minimumTileGap).toBeGreaterThanOrEqual(-.5)
    expect(metrics.minimumTileGap).toBeLessThanOrEqual(.5)
    expect(metrics.cssHandGap).toBe('0px')
    expect(Number.parseFloat(metrics.cssSlotWidth)).toBeCloseTo(40, 1)
    expect(Number.parseFloat(metrics.cssTileWidth)).toBeCloseTo(40, 1)
    expect(metrics.minimumControl.width).toBeGreaterThanOrEqual(43.5)
    expect(metrics.minimumControl.height).toBeGreaterThanOrEqual(43.5)
    expect(metrics.minimumHandHit.width).toBeGreaterThanOrEqual(43.5)
    expect(metrics.minimumHandHit.height).toBeGreaterThanOrEqual(43.5)
    expect(new Set(metrics.seatCardCssSizes).size).toBe(1)
    const cardSizeMatch = /^(\d+(?:\.\d+)?)pxx(\d+(?:\.\d+)?)px$/.exec(metrics.seatCardCssSizes[0]!)
    expect(cardSizeMatch).not.toBeNull()
    const cardWidth = Number.parseFloat(cardSizeMatch![1]!)
    const cardHeight = Number.parseFloat(cardSizeMatch![2]!)
    // R6.19：348dde3 注释掉 width: var(--seat-card-width) 后，手机卡宽统一回落为
    // clamp(76px, 7vw, 104px) 的 76px（四家一致）；本家 72px 遗留泄漏已移除。
    expect(cardWidth).toBeGreaterThanOrEqual(72.5)
    expect(cardWidth).toBeLessThanOrEqual(80)
    expect(cardHeight).toBeGreaterThanOrEqual(83.5)
    expect(cardHeight).toBeLessThanOrEqual(112.5)
    expect(metrics.seatCardSpread.width).toBeLessThanOrEqual(1)
    expect(metrics.seatCardSpread.height).toBeLessThanOrEqual(1)
    expect(Math.max(...metrics.scoreBottomInsets)).toBeLessThanOrEqual(16)
    expect(Math.min(...metrics.scoreBottomInsets)).toBeGreaterThanOrEqual(7)
    expect(Math.max(...metrics.scoreCenterOffsets)).toBeLessThanOrEqual(0.5)
    for (const name of metrics.mobileNames) {
      expect(name.whiteSpace).toBe('nowrap')
      expect(name.textOverflow).toBe('ellipsis')
      expect(name.clientHeight).toBeLessThanOrEqual(18)
      expect(name.scrollHeight).toBeLessThanOrEqual(name.clientHeight + 1)
    }
    expect(metrics.semanticDrawGaps.map((item) => item.position)).toEqual([2, 5, 8, 11, 14])
    for (const item of metrics.semanticDrawGaps) {
      expect(item.gap).toBeGreaterThan(item.baseGap)
      expect(item.extraGap).toBeCloseTo(8, 0)
    }
    expect(metrics.actionArtRatio).toBeCloseTo(1.15, 1)
    await page.screenshot({ path: `${evidenceRoot}/phone-matrix/llmAnime-${viewport.name}-${viewport.width}x${viewport.height}.png` })
  }
  await context.close()
})

test('移动端动作 cue 锚定到行动座位并远离牌桌中央（R6.19）', async ({ browser }) => {
  test.setTimeout(240_000)
  await mkdir(`${evidenceRoot}/action-cue`, { recursive: true })
  const cases = [
    { name: 'iphone-x', width: 812, height: 375 },
    { name: 'android-mainstream', width: 800, height: 360 },
    { name: 'iphone-se', width: 667, height: 375 },
  ]
  for (const viewport of cases) {
    const { context, page } = await createTouchPage(browser, viewport.width, viewport.height)
    for (const [seat, side] of [[3, 'left'], [2, 'top'], [1, 'right']] as const) {
      await page.goto(`/?theme=llmAnime&actionCueLab=peng&actionCueSeat=${seat}`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /开始东风场/ }).click()
      await expect(page.locator('.game-table-hud')).toBeVisible()
      await expect(page.locator('canvas.mahjong-scene')).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
      const metrics = await page.evaluate(() => {
        const rect = (selector: string) => {
          const value = document.querySelector(selector)?.getBoundingClientRect()
          return value ? {
            x: value.x, y: value.y, width: value.width, height: value.height,
            right: value.right, bottom: value.bottom,
            cx: value.x + value.width / 2, cy: value.y + value.height / 2,
          } : null
        }
        const overlap = (a: NonNullable<ReturnType<typeof rect>>, b: NonNullable<ReturnType<typeof rect>>) =>
          Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x))
          * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y))
        const cue = rect('.anime-action-cue')
        const topbar = rect('.top-bar')
        const hand = rect('.hand-rack')
        return {
          cue,
          topSeat: rect('.seat-top .avatar-wrap'),
          leftSeat: rect('.seat-left .avatar-wrap'),
          rightSeat: rect('.seat-right .avatar-wrap'),
          handOverlap: cue && hand ? overlap(cue, hand) : 0,
          topbarOverlap: cue && topbar ? overlap(cue, topbar) : 0,
          width: innerWidth,
        }
      })
      expect(metrics.cue).not.toBeNull()
      expect(metrics.handOverlap).toBe(0)
      expect(metrics.topbarOverlap).toBe(0)
      if (side === 'top') {
        // 对家：与对家卡同列（--top-seat-resolved-left，66%），位于卡下方，远离屏幕中央。
        expect(Math.abs(metrics.cue!.cx - metrics.topSeat!.cx)).toBeLessThanOrEqual(2)
        expect(metrics.cue!.y).toBeGreaterThanOrEqual(metrics.topSeat!.bottom - 10)
        expect(metrics.cue!.cx).toBeGreaterThanOrEqual(metrics.width * 0.6 - 2)
      } else if (side === 'left') {
        // 上家：贴左卡内缘（不再被 max(20%) 推进牌桌），垂直对齐卡中心。
        expect(metrics.cue!.x).toBeGreaterThanOrEqual(metrics.leftSeat!.right - 2)
        expect(Math.abs(metrics.cue!.cy - metrics.leftSeat!.cy)).toBeLessThanOrEqual(6)
      } else {
        // 下家：贴右卡内缘，垂直对齐卡中心。
        expect(metrics.cue!.right).toBeLessThanOrEqual(metrics.rightSeat!.x + 2)
        expect(Math.abs(metrics.cue!.cy - metrics.rightSeat!.cy)).toBeLessThanOrEqual(6)
      }
      await page.screenshot({ path: `${evidenceRoot}/action-cue/llmAnime-${viewport.name}-seat-${side}.png` })
    }
    await context.close()
  }
})

test('桌面命名分辨率与任意拖拽尺寸连续适配', async ({ page }) => {
  test.setTimeout(180_000)
  await mkdir(`${evidenceRoot}/desktop-matrix`, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await startMatch(page, 'jade', false, true)

  const randomViewports = [
    { width: 901, height: 507 }, { width: 999, height: 699 },
    { width: 1000, height: 626 }, { width: 1000, height: 621 },
    { width: 1000, height: 503 }, { width: 1000, height: 497 },
    { width: 1111, height: 777 }, { width: 1537, height: 641 },
    { width: 1703, height: 901 }, { width: 2049, height: 1153 },
    { width: 2237, height: 997 }, { width: 2879, height: 1599 },
  ]
  for (const viewport of [...desktopViewports, ...randomViewports]) {
    await page.setViewportSize(viewport)
    await expect.poll(async () => page.evaluate(() => {
      const canvas = document.querySelector('canvas.mahjong-scene')!.getBoundingClientRect()
      const aspect = canvas.width / canvas.height
      const baseFovRadians = 39 * Math.PI / 180
      const expected = aspect >= 16 / 9
        ? 39
        : 2 * Math.atan(Math.tan(baseFovRadians / 2) * (16 / 9) / aspect) * 180 / Math.PI
      const actual = Number(document.querySelector('canvas.mahjong-scene')?.getAttribute('data-camera-fov'))
      return Math.abs(actual - expected)
    }), { timeout: 3_000 }).toBeLessThan(.05)
    const metrics = await page.evaluate(() => {
      const game = document.querySelector('.game-app')!.getBoundingClientRect()
      const canvas = document.querySelector('canvas.mahjong-scene')!.getBoundingClientRect()
      const topbar = document.querySelector('.top-bar')!.getBoundingClientRect()
      const topSeat = document.querySelector('.seat-top .avatar-wrap')!.getBoundingClientRect()
      const rightSeat = document.querySelector('.seat-right .avatar-wrap')!.getBoundingClientRect()
      const leftSeat = document.querySelector('.seat-left .avatar-wrap')!.getBoundingClientRect()
      const hand = document.querySelector('.hand-rack')!.getBoundingClientRect()
      const aspect = innerWidth / innerHeight
      const overlap = (left: DOMRect, right: DOMRect) => Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
        * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
      return {
        viewport: { width: innerWidth, height: innerHeight },
        game: { width: game.width, height: game.height },
        canvas: { width: canvas.width, height: canvas.height },
        cameraFov: Number(document.querySelector('canvas.mahjong-scene')?.getAttribute('data-camera-fov')),
        aspect,
        cameraAspect: canvas.width / canvas.height,
        overflow: { x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight },
        topbarOverlap: overlap(topSeat, topbar),
        topRightOverlap: overlap(topSeat, rightSeat),
        hudBounds: {
          left: Math.min(leftSeat.left, topSeat.left, hand.left),
          top: Math.min(leftSeat.top, topSeat.top, hand.top),
          right: Math.max(rightSeat.right, topSeat.right, hand.right),
          bottom: Math.max(leftSeat.bottom, rightSeat.bottom, topSeat.bottom, hand.bottom),
        },
      }
    })
    expect(metrics.viewport).toEqual({ width: viewport.width, height: viewport.height })
    expect(metrics.game).toEqual(metrics.canvas)
    expect(metrics.game.width).toBeCloseTo(viewport.width, 0)
    expect(metrics.game.height).toBeCloseTo(viewport.height, 0)
    expect(metrics.overflow).toEqual({ x: 0, y: 0 })
    expect(metrics.topbarOverlap).toBe(0)
    expect(metrics.topRightOverlap).toBe(0)
    expect(metrics.hudBounds.left).toBeGreaterThanOrEqual(-.5)
    expect(metrics.hudBounds.top).toBeGreaterThanOrEqual(-.5)
    expect(metrics.hudBounds.right).toBeLessThanOrEqual(viewport.width + .5)
    expect(metrics.hudBounds.bottom).toBeLessThanOrEqual(viewport.height + .5)
    const baseFovRadians = 39 * Math.PI / 180
    const expectedFov = metrics.cameraAspect >= 16 / 9
      ? 39
      : 2 * Math.atan(Math.tan(baseFovRadians / 2) * (16 / 9) / metrics.cameraAspect) * 180 / Math.PI
    expect(metrics.cameraFov).toBeCloseTo(expectedFov, 1)

    const named = desktopViewports.find((candidate) => candidate.width === viewport.width && candidate.height === viewport.height)
    if (named) await page.screenshot({ path: `${evidenceRoot}/desktop-matrix/jade-${named.name}-${named.width}x${named.height}.png` })
  }
})

test('4K DPR=2 保持 CSS 布局与高分辨率 Canvas 一致', async ({ browser }) => {
  test.setTimeout(90_000)
  await mkdir(`${evidenceRoot}/desktop-matrix`, { recursive: true })
  const port = Number(process.env.E2E_PORT || 4173)
  const context = await browser.newContext({
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  await startMatch(page, 'jade', false, true)
  const metrics = await page.locator('canvas.mahjong-scene').evaluate((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect()
    return {
      css: { width: rect.width, height: rect.height },
      backing: { width: canvas.width, height: canvas.height },
      dpr: devicePixelRatio,
    }
  })
  expect(metrics.css).toEqual({ width: 1920, height: 1080 })
  expect(metrics.dpr).toBe(2)
  expect(metrics.backing).toEqual({ width: 3840, height: 2160 })
  await page.screenshot({ path: `${evidenceRoot}/desktop-matrix/jade-4k-dpr2-1920x1080-css.png` })
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

test('896×414 下对家避开中央牌河且本家牌保持麻将比例', async ({ browser }) => {
  test.setTimeout(60_000)
  await mkdir(`${evidenceRoot}/extreme`, { recursive: true })
  const { context, page } = await createTouchPage(browser, 896, 414)
  await startMatch(page, 'llm')
  await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(13)

  const metrics = await page.evaluate(() => {
    const topSeat = document.querySelector('.seat-top .avatar-wrap')!.getBoundingClientRect()
    const rightSeat = document.querySelector('.seat-right .avatar-wrap')!.getBoundingClientRect()
    const slot = document.querySelector('.hand-tile-slot')!.getBoundingClientRect()
    const hitArea = document.querySelector('.hand-hit-area')!.getBoundingClientRect()
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
      hitArea: { width: hitArea.width, height: hitArea.height },
      tile: { width: tile.width, height: tile.height, aspect: tile.width / tile.height },
      minimumTileGap,
      cssHandGap: getComputedStyle(document.querySelector('.hand-rack')!).gap,
    }
  })

  expect(metrics.topSeatLeftRatio).toBeGreaterThanOrEqual(.6) // 对家锚点 66%（R6.17 偏长档与基准一致），右于中央牌河
  expect(metrics.topRightOverlap).toBe(0)
  expect(metrics.slot.width).toBeCloseTo(40, 1)
  expect(metrics.hitArea.width).toBeGreaterThanOrEqual(43.5)
  expect(metrics.hitArea.height).toBeGreaterThanOrEqual(43.5)
  expect(metrics.tile.width).toBeCloseTo(40, 1)
  expect(metrics.tile.aspect).toBeCloseTo(.8, 2)
  expect(metrics.minimumTileGap).toBeGreaterThanOrEqual(-.5)
  expect(metrics.minimumTileGap).toBeLessThanOrEqual(.5)
  expect(metrics.cssHandGap).toBe('0px')
  await page.screenshot({ path: `${evidenceRoot}/extreme/llm-896x414-game.png` })
  await context.close()
})

test('896×414 左右家气泡位于头像下方且尾巴朝上', async ({ browser }) => {
  test.setTimeout(60_000)
  await mkdir(`${evidenceRoot}/extreme`, { recursive: true })
  const { context, page } = await createTouchPage(browser, 896, 414)
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
  await context.close()
})

test('reduced motion 下胡牌立绘仍先于 Three.js 光效退出', async ({ browser }) => {
  test.setTimeout(60_000)
  await mkdir(`${evidenceRoot}/reduced-motion`, { recursive: true })
  const { context, page } = await createTouchPage(browser, 667, 375)
  await page.emulateMedia({ reducedMotion: 'reduce' })
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
  await context.close()
})

test('宽桌面窗口座位锚到牌桌盒、对家不右移、手牌随牌桌高向缩放', async ({ page }) => {
  test.setTimeout(120_000)
  await mkdir(`${evidenceRoot}/desktop-matrix`, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await startMatch(page, 'llmAnime', false, true)
  // 等发牌完成（本家手牌第一张落地）。
  await page.waitForSelector('.hand-rack .mahjong-tile', { timeout: 30_000 })

  const measure = () => page.evaluate(() => {
    const rect = (sel: string) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, center: r.left + r.width / 2, width: r.width }
    }
    const w = innerWidth
    const h = innerHeight
    // 与 CSS 一致的牌桌盒左偏移：宽于 16:9 时居中盒左缘。
    const tableBoxLeft = Math.max(0, (w - h * 16 / 9) / 2)
    const tile = document.querySelector('.hand-rack .mahjong-tile')
    return {
      w,
      h,
      tableBoxLeft,
      leftSeat: rect('.seat-left .avatar-wrap'),
      rightSeat: rect('.seat-right .avatar-wrap'),
      topSeat: rect('.seat-top .avatar-wrap'),
      tileWidth: tile ? tile.getBoundingClientRect().width : 0,
    }
  })

  // 2250×1209（比 16:9 宽）：左右家应离开屏幕边缘、贴近牌桌盒。
  await page.setViewportSize({ width: 2250, height: 1209 })
  await page.waitForTimeout(250)
  const wide = await measure()
  expect(wide.leftSeat!.left).toBeGreaterThan(wide.w * 0.027 + 20) // 明显离开旧 2.7% 窗口锚点
  expect(wide.leftSeat!.left).toBeCloseTo(wide.tableBoxLeft + wide.w * 0.027, 0)
  expect(wide.rightSeat!.right).toBeLessThan(wide.w - wide.w * 0.027 - 20)
  expect(wide.topSeat!.center).toBeCloseTo(wide.w / 2 + 365, 0) // 对家仍用 50%+365 基准，不右移
  // 手牌随容器高缩放：≈ 7.97cqh（1080p 时 86px，1209 高时应 > 90px）
  expect(wide.tileWidth).toBeGreaterThan(90)
  await page.screenshot({ path: `${evidenceRoot}/desktop-matrix/llmAnime-2250x1209-aligned.png` })

  // 3440×1440（带鱼屏）：对家不应被偏长档钉到 84%，仍在 50%+365 基准附近。
  await page.setViewportSize({ width: 3440, height: 1440 })
  await page.waitForTimeout(250)
  const ultrawide = await measure()
  expect(ultrawide.topSeat!.center).toBeCloseTo(3440 / 2 + 365, 0)
  await page.screenshot({ path: `${evidenceRoot}/desktop-matrix/llmAnime-3440x1440-aligned.png` })
})
