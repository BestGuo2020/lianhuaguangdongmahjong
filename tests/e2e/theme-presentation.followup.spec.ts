import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const evidenceRoot = 'test-results/theme-presentation/phase11'
const themes = ['jade', 'happyMahjong', 'rosewood', 'llm', 'llmAnime'] as const

async function expectPreviewReady(page: import('@playwright/test').Page) {
  await expect.poll(() => page.locator('.theme-showcase-frame img').evaluate((image: HTMLImageElement) => ({
    complete: image.complete,
    width: image.naturalWidth,
  })), { timeout: 45_000 }).toEqual({ complete: true, width: expect.any(Number) })
  expect(await page.locator('.theme-showcase-frame img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await expect(page.locator('.theme-showcase')).toHaveAttribute('data-preview-state', 'ready')
}

test.beforeAll(async () => {
  await mkdir(`${evidenceRoot}/lobby`, { recursive: true })
})

test('Phase 8 五主题桌面大厅使用主题视觉区与对局操作区', async ({ page }) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1366, height: 768 })

  for (const theme of themes) {
    await page.goto(`/?theme=${theme}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', theme)
    await expect(page.locator('.lobby-layout')).toBeVisible()
    await expect(page.locator('.lobby-visual')).toHaveAttribute('data-visual-theme', theme)
    await expectPreviewReady(page)

    const regions = await page.evaluate(() => {
      const visual = document.querySelector('.lobby-visual')!.getBoundingClientRect()
      const actions = document.querySelector('.lobby-actions')!.getBoundingClientRect()
      return {
        visual: { left: visual.left, right: visual.right, width: visual.width },
        actions: { left: actions.left, right: actions.right, width: actions.width },
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    expect(regions.visual.width).toBeGreaterThan(360)
    expect(regions.actions.width).toBeGreaterThan(340)
    expect(regions.visual.right).toBeLessThanOrEqual(regions.actions.left + 1)
    expect(regions.overflow).toBeLessThanOrEqual(1)
    await expect(page.locator('.start-button')).toHaveCount(1)
    await expect(page.locator('.start-button')).toHaveAttribute('data-action-role', 'primary')
    await expect(page.locator('.current-config')).toHaveCount(0)
    await expect(page.locator('.character-shortcut')).toHaveCount(theme === 'llmAnime' ? 1 : 0)
    if (theme === 'jade' || theme === 'happyMahjong' || theme === 'rosewood') {
      await expect(page.locator('.theme-showcase-frame img')).toHaveAttribute('src', new RegExp(`/themes/lobby/v1/${theme}\\.png$`))
    }
    await page.screenshot({ path: `${evidenceRoot}/lobby/${theme}-1366x768.png` })
  }
})

test('Phase 8 竖屏只显示横屏门禁与全屏横屏入口', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/?theme=llmAnime', { waitUntil: 'domcontentloaded' })
  const gate = page.locator('.orientation-gate')
  await expect(gate).toBeVisible()
  await expect(gate).toHaveAttribute('data-table-theme', 'llmAnime')
  await expect(page.getByRole('heading', { name: '请横屏游玩' })).toBeVisible()
  await expect(page.getByRole('button', { name: '进入全屏横屏' })).toBeVisible()
  await expect(page.locator('.lobby')).toBeHidden()
  await page.screenshot({ path: `${evidenceRoot}/lobby/llmAnime-390x844-orientation-gate.png` })
  await context.close()
})

test('Phase 8 手机横屏大厅无页面级滚动且触控拖动不移动根布局', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 667, height: 375 },
    screen: { width: 667, height: 375 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/?theme=happyMahjong', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.orientation-gate')).toHaveCount(0)
  await expectPreviewReady(page)

  const before = await page.evaluate(() => {
    const sizes = (element: HTMLElement) => ({
      width: element.scrollWidth - element.clientWidth,
      height: element.scrollHeight - element.clientHeight,
      top: element.getBoundingClientRect().top,
    })
    return {
      html: sizes(document.documentElement),
      body: sizes(document.body),
      app: sizes(document.querySelector('.game-app') as HTMLElement),
      lobby: sizes(document.querySelector('.lobby') as HTMLElement),
    }
  })
  for (const target of [before.html, before.body, before.app, before.lobby]) {
    expect(target.width).toBeLessThanOrEqual(1)
    expect(target.height).toBeLessThanOrEqual(1)
  }
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 40, y: 180 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 40, y: 80 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  expect(await page.locator('.lobby').evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before.lobby.top, 1)
  await page.screenshot({ path: `${evidenceRoot}/lobby/happyMahjong-667x375.png` })
  await context.close()
})

test('Phase 10 llmAnime 选择器即时保存并更新欢迎文字', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/?theme=llmAnime', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.theme-showcase-kicker')).toHaveText('当前本家形象')
  await expect(page.locator('.anime-table-theme')).toHaveText('牌桌主题 · 大模型二次元')
  await expect(page.getByTestId('anime-welcome')).toHaveText('准备好一起开局了吗？')
  await expect(page.locator('.lobby')).not.toContainText('与四名牌手身份无关')

  await page.locator('.character-shortcut').click()
  const picker = page.locator('.anime-character-picker')
  await expect(picker).toBeVisible()
  await expect(page.getByTestId('anime-character-preview')).toContainText('大肥鱼')

  const qwen = page.getByRole('radio', { name: /千问大小姐/ })
  await qwen.click()
  await expect(qwen).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('anime-character-preview')).toContainText('千问大小姐')
  await expect(page.getByTestId('anime-character-preview')).toContainText('礼貌自信')
  await expect(page.getByTestId('anime-welcome')).toHaveText('准备好一起开局了吗？')
  await expect(page.locator('.character-shortcut')).toHaveAccessibleName('更换本家形象')
  await expect(picker).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('llm-anime.character.v1'))).toBe('qwen')
})

test('Phase 10 图片失败时保留角色文字与选择能力', async ({ page }) => {
  await page.route('**/img/llm/**', (route) => route.fulfill({ status: 404, body: '' }))
  await page.goto('/?theme=llmAnime', { waitUntil: 'domcontentloaded' })
  await page.locator('.character-shortcut').click()
  await expect(page.locator('.anime-avatar-fallback').first()).toBeVisible()
  const claude = page.getByRole('radio', { name: /克劳德书姬/ })
  await claude.click()
  await expect(claude).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('anime-character-preview')).toContainText('克劳德书姬')
})

test('Phase 10 移动横屏角色选择器固定预览且仅卡片区滚动', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 667, height: 375 },
    screen: { width: 667, height: 375 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/?theme=llmAnime', { waitUntil: 'domcontentloaded' })
  await page.locator('.character-shortcut').click()
  const grid = page.locator('.anime-character-grid')
  const preview = page.getByTestId('anime-character-preview')
  await expect(preview).toBeVisible()
  const before = await page.evaluate(() => ({
    dialogTop: document.querySelector('.lobby-dialog')!.getBoundingClientRect().top,
    previewTop: document.querySelector('[data-testid="anime-character-preview"]')!.getBoundingClientRect().top,
    lobbyTop: document.querySelector('.lobby')!.getBoundingClientRect().top,
    gridScrollable: (document.querySelector('.anime-character-grid') as HTMLElement).scrollHeight
      > (document.querySelector('.anime-character-grid') as HTMLElement).clientHeight,
  }))
  expect(before.gridScrollable).toBe(true)
  const box = await grid.boundingBox()
  expect(box).not.toBeNull()
  const cdp = await context.newCDPSession(page)
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2
  const startY = (box?.y ?? 0) + (box?.height ?? 0) - 12
  const endY = (box?.y ?? 0) + 12
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: endY }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(150)
  expect(await grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const after = await page.evaluate(() => ({
    dialogTop: document.querySelector('.lobby-dialog')!.getBoundingClientRect().top,
    previewTop: document.querySelector('[data-testid="anime-character-preview"]')!.getBoundingClientRect().top,
    lobbyTop: document.querySelector('.lobby')!.getBoundingClientRect().top,
  }))
  expect(after.dialogTop).toBeCloseTo(before.dialogTop, 1)
  expect(after.previewTop).toBeCloseTo(before.previewTop, 1)
  expect(after.lobbyTop).toBeCloseTo(before.lobbyTop, 1)
  for (const name of ['克劳德书姬', 'MiniMax导演', '米斯特拉风狐', '千问大小姐']) {
    const label = page.getByRole('radio', { name: new RegExp(name) }).locator(':scope > span:not(.anime-character-thumb)')
    await expect(label).toHaveCSS('white-space', 'normal')
    await expect(label).not.toHaveCSS('text-overflow', 'ellipsis')
  }
  await page.screenshot({ path: `${evidenceRoot}/lobby/llmAnime-picker-667x375.png` })
  await context.close()
})

test('Phase 8 实体牌桌预览失败时显示明确回退', async ({ page }) => {
  await page.route('**/themes/lobby/v1/jade.png', (route) => route.fulfill({ status: 503, body: '' }))
  await page.goto('/?theme=jade', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.theme-showcase')).toHaveAttribute('data-preview-state', 'error')
  await expect(page.locator('.theme-showcase-fallback')).toContainText('预览暂不可用')
  await expect(page.getByRole('button', { name: /开始东风场/ })).toBeEnabled()
})

test('Phase 9 Teleport 弹层继承主题并在热切换时保留表单内容', async ({ page }) => {
  await page.goto('/?theme=happyMahjong', { waitUntil: 'domcontentloaded' })
  await page.locator('.game-settings button').first().click()
  const dialogSurface = page.locator('[data-teleport-surface="lobby-dialog"]')
  await expect(dialogSurface).toHaveAttribute('data-table-theme', 'happyMahjong')
  const happyDialogBackground = await page.locator('.lobby-dialog').evaluate((element) => getComputedStyle(element).backgroundImage)

  await page.getByLabel('切换牌桌主题').evaluate((element: HTMLButtonElement) => element.click())
  await page.getByRole('menuitemradio', { name: /红木金丝/ }).evaluate((element: HTMLButtonElement) => element.click())
  await expect(dialogSurface).toHaveAttribute('data-table-theme', 'rosewood')
  expect(await page.locator('.lobby-dialog').evaluate((element) => getComputedStyle(element).backgroundImage)).not.toBe(happyDialogBackground)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialogSurface).toHaveCount(0)

  await page.getByTestId('llm-fab').click()
  const settings = page.locator('[data-teleport-surface="llm-settings"]')
  await expect(settings).toHaveAttribute('data-table-theme', 'rosewood')
  await page.getByTestId('llm-add').click()
  await page.getByTestId('llm-name').fill('主题切换保护')
  await page.getByTestId('llm-api-key').fill('masked-secret')
  await expect(page.getByTestId('llm-api-key')).toHaveAttribute('type', 'password')

  await page.getByLabel('切换牌桌主题').evaluate((element: HTMLButtonElement) => element.click())
  await page.getByRole('menuitemradio', { name: /大模型专属/ }).evaluate((element: HTMLButtonElement) => element.click())
  await expect(settings).toHaveAttribute('data-table-theme', 'llm')
  await expect(page.getByTestId('llm-name')).toHaveValue('主题切换保护')
  await expect(page.getByTestId('llm-api-key')).toHaveValue('masked-secret')
  await page.getByTestId('llm-close').click()
  await expect(settings).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveAttribute('data-table-theme')
  await expect(page.locator('body')).not.toHaveAttribute('style')
})

test('Phase 9 五主题场次、玩法与大模型配置表面均取得当前主题', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1366, height: 768 })
  const dialogFingerprints: string[] = []
  const settingsFingerprints: string[] = []

  for (const theme of themes) {
    await page.goto(`/?theme=${theme}`, { waitUntil: 'domcontentloaded' })
    await page.locator('.game-settings button').first().click()
    const dialogSurface = page.locator('[data-teleport-surface="lobby-dialog"]')
    await expect(dialogSurface).toHaveAttribute('data-table-theme', theme)
    dialogFingerprints.push(await page.locator('.lobby-dialog').evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.backgroundImage}|${style.borderColor}|${style.borderRadius}`
    }))
    await page.getByRole('button', { name: '关闭' }).click()

    await page.locator('.game-settings button').nth(1).click()
    await expect(dialogSurface).toHaveAttribute('data-table-theme', theme)
    await expect(page.locator('.lobby-dialog')).toBeVisible()
    await expect(page.locator('.rule-picker-options')).toContainText('莲花广麻')
    await expect(page.locator('.view-rules-link')).toBeVisible()
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${evidenceRoot}/lobby/${theme}-rule-dialog-1366x768.png` })
    await page.getByRole('button', { name: '关闭' }).click()

    await page.getByTestId('llm-fab').click()
    const settings = page.locator('[data-teleport-surface="llm-settings"]')
    await expect(settings).toHaveAttribute('data-table-theme', theme)
    settingsFingerprints.push(await settings.evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.backgroundImage}|${style.borderColor}|${style.borderRadius}|${style.colorScheme}`
    }))
    await page.screenshot({ path: `${evidenceRoot}/lobby/${theme}-llm-settings-1366x768.png` })
    await page.getByTestId('llm-close').click()
  }

  expect(new Set(dialogFingerprints).size).toBe(themes.length)
  expect(new Set(settingsFingerprints).size).toBe(themes.length)
})

test('Phase 11 废弃主题仍回退 jade，新增大厅在 reduced-motion 下稳定', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?theme=majsoul', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'jade')
  await expect(page).toHaveURL(/theme=jade/)
  await expect(page.locator('.lobby-visual')).toHaveAttribute('data-visual-theme', 'jade')
  const motion = await page.locator('.theme-showcase').evaluate((element) => {
    const style = getComputedStyle(element)
    return { animation: style.animationName, transition: style.transitionDuration, transform: style.transform }
  })
  expect(motion.animation).toBe('none')
  expect(Number.parseFloat(motion.transition)).toBeLessThanOrEqual(.001)
  expect(motion.transform).toBe('none')
})

test('Phase 9 返回结算时恢复稳定最终状态', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/?theme=jade&winEffectLab=1', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 60_000 })
  await page.getByTestId('win-self-0').evaluate((element: HTMLElement) => element.click())
  const settlement = page.locator('.round-settlement')
  await expect(settlement).toBeVisible({ timeout: 45_000 })
  await expect(settlement).toHaveAttribute('data-settlement-state', 'entering')
  await page.getByRole('button', { name: '查看牌桌' }).click()
  await page.getByRole('button', { name: '查看结算' }).click()
  await expect(settlement).toHaveAttribute('data-settlement-state', 'restored')
  await expect(page.locator('.round-rankings article').first()).toHaveCSS('animation-name', 'none')
})

test('Phase 10 llmAnime 思考气泡、call 与 win 复用既有轻量资产', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/?theme=llmAnime&bubbleLab=1&actionCueLab=peng&actionCueSeat=1', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 60_000 })
  const bubble = page.locator('.seat-right .llm-bubble')
  await expect(bubble).toBeVisible()
  await expect(bubble).not.toContainText(/reasoning|chain of thought|原始推理/i)

  const cue = page.locator('.anime-action-cue')
  await expect(cue).toHaveAttribute('data-action-kind', 'peng')
  await expect(cue.locator('img').first()).toHaveAttribute('src', /\/actions\/call\.jpg$/)
  await page.evaluate(() => {
    const labWindow = window as typeof window & { __setTableActionCueLab?: (type: string, actorIndex?: number) => void }
    labWindow.__setTableActionCueLab?.('self-draw', 1)
  })
  await expect(cue).toHaveAttribute('data-action-kind', 'win')
  await expect(cue.locator('img').first()).toHaveAttribute('src', /\/actions\/win\.jpg$/)
})

test('Phase 8 移动联机入房后聚焦房间且房间码稳定居中', async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    screen: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    localStorage.setItem('lgm_disclaimer_agreed', '1')
    localStorage.removeItem('lgm_session')
  })
  await page.goto('/?theme=llmAnime', { waitUntil: 'domcontentloaded' })
  await page.getByRole('radio', { name: /联机对战/ }).click()
  await page.locator('.remote-field input').fill('布局验收')
  await expect(page.locator('.remote-create')).toHaveAttribute('data-action-role', 'primary')
  await expect(page.locator('.remote-join-btn')).toHaveAttribute('data-action-role', 'primary')
  await page.locator('.remote-create').click()
  await expect(page.locator('.lobby-dialog .dialog-actions .primary')).toHaveAttribute('data-action-role', 'primary')
  await page.locator('.lobby-dialog .dialog-actions .primary').click()
  const room = page.locator('.room-panel')
  await expect(room).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.lobby')).toHaveClass(/room-focused/)
  await expect(page.locator('.lobby-visual')).toBeHidden()
  await expect(room.locator('.anime-character-picker')).toHaveCount(0)
  await expect(room.locator('.room-character-entry')).toBeVisible()
  await expect(room.locator('.room-seat')).toHaveCount(4)
  await expect(room.locator('.room-owner-actions .secondary')).toBeVisible({ timeout: 20_000 })
  await expect(room.locator('.room-owner-actions .secondary')).toHaveAttribute('data-action-role', 'primary')
  await expect(room.locator('.room-start')).toBeVisible({ timeout: 20_000 })
  await expect(room.locator('.room-start')).toHaveAttribute('data-action-role', 'disabled')

  const themeLabels: Record<(typeof themes)[number], RegExp> = {
    jade: /默认墨玉/,
    happyMahjong: /欢乐麻将/,
    rosewood: /红木金丝/,
    llm: /大模型专属/,
    llmAnime: /大模型二次元/,
  }
  const roomFingerprints: string[] = []
  for (const theme of themes) {
    await page.getByLabel('切换牌桌主题').click()
    await page.getByRole('menuitemradio', { name: themeLabels[theme] }).click()
    await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', theme)
    roomFingerprints.push(await room.evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.backgroundColor}|${style.borderColor}|${style.boxShadow}`
    }))
    await page.screenshot({ path: `${evidenceRoot}/lobby/${theme}-room-844x390.png` })
  }
  expect(new Set(roomFingerprints).size).toBe(themes.length)
  await expect(room.locator('.room-character-entry')).toBeVisible()

  const roomCodeCenter = async () => page.evaluate(() => {
    const panel = document.querySelector('.room-panel')!.getBoundingClientRect()
    const code = document.querySelector('.room-code strong')!.getBoundingClientRect()
    return { panel: panel.left + panel.width / 2, code: code.left + code.width / 2 }
  })
  const beforeCopy = await roomCodeCenter()
  expect(Math.abs(beforeCopy.code - beforeCopy.panel)).toBeLessThanOrEqual(2)
  await page.locator('.room-code').click()
  await expect(page.locator('.room-code-copied')).toHaveClass(/visible/)
  const afterCopy = await roomCodeCenter()
  expect(Math.abs(afterCopy.code - beforeCopy.code)).toBeLessThanOrEqual(1)

  for (const viewport of [
    { width: 844, height: 390 },
    { width: 800, height: 360 },
    { width: 667, height: 375 },
    { width: 568, height: 320 },
  ]) {
    await page.setViewportSize(viewport)
    const layout = await page.evaluate(() => {
      const measure = (element: HTMLElement) => ({
        width: element.scrollWidth - element.clientWidth,
        height: element.scrollHeight - element.clientHeight,
      })
      const seats = document.querySelector('.room-seats') as HTMLElement
      return {
        html: measure(document.documentElement),
        body: measure(document.body),
        app: measure(document.querySelector('.game-app') as HTMLElement),
        lobby: measure(document.querySelector('.lobby') as HTMLElement),
        seats: measure(seats),
        readyVisible: Boolean(document.querySelector('.room-owner-actions .secondary')?.getBoundingClientRect().height),
        startVisible: Boolean(document.querySelector('.room-start')?.getBoundingClientRect().height),
      }
    })
    for (const root of [layout.html, layout.body, layout.app, layout.lobby]) {
      expect(root.width, `${viewport.width} root horizontal overflow`).toBeLessThanOrEqual(1)
      expect(root.height, `${viewport.width} root vertical overflow`).toBeLessThanOrEqual(1)
    }
    expect(layout.readyVisible).toBe(true)
    expect(layout.startVisible).toBe(true)
    if (viewport.height > 340) expect(layout.seats.height).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `${evidenceRoot}/lobby/llmAnime-room-${viewport.width}x${viewport.height}.png` })
  }

  await page.locator('.room-character-entry').click()
  await expect(page.locator('.lobby-dialog.character-dialog')).toBeVisible()
  await expect(page.locator('.anime-character-picker')).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await room.getByRole('button', { name: '关闭房间' }).click()
  await expect(room).toHaveCount(0)
  await context.close()
})
