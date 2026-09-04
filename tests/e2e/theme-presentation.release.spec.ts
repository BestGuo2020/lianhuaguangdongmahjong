import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const evidenceRoot = 'test-results/theme-presentation/phase7'
const themes = [
  { name: 'jade', label: '默认墨玉' },
  { name: 'happyMahjong', label: '欢乐麻将' },
  { name: 'rosewood', label: '红木金丝' },
  { name: 'llm', label: '大模型专属' },
  { name: 'llmAnime', label: '大模型二次元' },
] as const

async function waitForTable(page: Page, theme: string) {
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('canvas.mahjong-scene')).toHaveCount(1)
  await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-table-theme', theme)
}

test('GPU 验证使用硬件 WebGL renderer 而非软件光栅', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium-gpu', '仅 GPU 项目运行')
  test.setTimeout(120_000)
  await mkdir(`${evidenceRoot}/gpu`, { recursive: true })
  await page.goto('/?theme=llm&perf=1', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await waitForTable(page, 'llm')

  const gpu = await page.locator('canvas.mahjong-scene').evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return { vendor: '', renderer: '', version: '', available: false }
    const extension = gl.getExtension('WEBGL_debug_renderer_info')
    const vendor = extension ? String(gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR))
    const renderer = extension ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
    return { vendor, renderer, version: String(gl.getParameter(gl.VERSION)), available: true }
  })

  expect(gpu.available).toBe(true)
  expect(`${gpu.vendor} ${gpu.renderer}`).not.toMatch(/swiftshader|llvmpipe|software rasterizer/i)
  console.log(`[gpu] vendor=${gpu.vendor}; renderer=${gpu.renderer}; version=${gpu.version}`)
  await page.screenshot({ path: `${evidenceRoot}/gpu/llm-hardware-webgl.png` })
})

test('运行中切换五主题不会残留 DOM、探针或重复牌面缓存', async ({ page }) => {
  test.setTimeout(300_000)
  await mkdir(`${evidenceRoot}/switching`, { recursive: true })
  const legacyTileRequests = new Map<string, number>()
  const animeTileRequests = new Map<string, number>()
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    const target = path.includes('/themes/llm-anime/v1/tiles/')
      ? animeTileRequests
      : path.startsWith('/tiles/') ? legacyTileRequests : null
    if (target) target.set(path, (target.get(path) ?? 0) + 1)
  })

  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/?theme=jade&winEffectLab=1', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await waitForTable(page, 'jade')
  await page.locator('.win-effect-lab').evaluate((element: HTMLElement) => { element.style.visibility = 'hidden' })
  await page.getByTestId('win-self-0').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.settlement-card')).toBeVisible({ timeout: 45_000 })
  await page.getByRole('button', { name: '查看牌桌' }).click()
  await expect(page.locator('.settlement-card')).toBeHidden()

  await page.waitForTimeout(500)
  const idleStart = await page.evaluate(() => (window as typeof window & { __tableRenderedFrames?: () => number }).__tableRenderedFrames?.() ?? -1)
  await page.waitForTimeout(750)
  const idleEnd = await page.evaluate(() => (window as typeof window & { __tableRenderedFrames?: () => number }).__tableRenderedFrames?.() ?? -1)
  expect(idleStart).toBeGreaterThan(0)
  expect(idleEnd - idleStart).toBeLessThanOrEqual(1)
  const initialDrawCalls = await page.evaluate(() => (window as typeof window & { __tableDrawCalls?: () => number }).__tableDrawCalls?.() ?? -1)
  expect(initialDrawCalls).toBeGreaterThan(0)
  expect(initialDrawCalls).toBeLessThan(320)

  const fingerprints = new Set<string>()
  for (const theme of [...themes.slice(1), themes[0]]) {
    await page.evaluate(() => {
      const debugWindow = window as typeof window & {
        __tableRenderedFrames?: () => number
        __previousTableProbe?: () => number
      }
      debugWindow.__previousTableProbe = debugWindow.__tableRenderedFrames
    })
    await page.getByRole('button', { name: '切换牌桌主题' }).click()
    await page.getByRole('menuitemradio', { name: new RegExp(theme.label) }).click()
    await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', theme.name)
    await waitForTable(page, theme.name)
    await expect(page.locator('.theme-menu')).toBeHidden()
    expect(await page.evaluate(() => {
      const debugWindow = window as typeof window & {
        __tableRenderedFrames?: () => number
        __previousTableProbe?: () => number
      }
      return debugWindow.__tableRenderedFrames !== debugWindow.__previousTableProbe
    })).toBe(true)
    const fingerprint = await page.locator('main.game-app').evaluate((element) => {
      const style = getComputedStyle(element)
      return [
        style.getPropertyValue('--theme-accent').trim(),
        style.getPropertyValue('--theme-panel').trim(),
        style.backgroundImage,
      ].join('|')
    })
    fingerprints.add(fingerprint)
    await page.screenshot({ path: `${evidenceRoot}/switching/${theme.name}.png` })
  }

  expect(fingerprints.size).toBe(themes.length)
  expect([...legacyTileRequests.values()].every((count) => count === 1)).toBe(true)
  expect(legacyTileRequests.size).toBe(34)
  // 切入 llmAnime 时，已挂载的 2D 牌面可能先走一次 HTTP，随后 3D 预载再取同 URL；
  // 浏览器缓存负责网络复用，解码缓存是否只建一份由 tileAssets 单测保证。
  expect([...animeTileRequests.values()].every((count) => count <= 2)).toBe(true)
  expect(animeTileRequests.size).toBe(34)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lianhua-guangma:table-theme:v1'))).toBe('jade')
  await expect.poll(() => new URL(page.url()).searchParams.get('theme')).toBe('jade')
  expect(await page.locator('main.game-app').evaluate((element) => getComputedStyle(element).getPropertyValue('--anime-coral').trim())).toBe('')
})

test('主题可选纹理失败时回退纯色和渐变且继续 ready', async ({ page }) => {
  test.setTimeout(180_000)
  await mkdir(`${evidenceRoot}/fallbacks`, { recursive: true })
  const failedOptionalAssets: string[] = []
  await page.route(/\/(img\/llm-table\.webp|themes\/llm-anime\/v1\/(table-felt\.png|tile-back\.png))$/, async (route) => {
    failedOptionalAssets.push(new URL(route.request().url()).pathname)
    await route.abort()
  })

  await page.goto('/?theme=llm', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await waitForTable(page, 'llm')
  await expect(page.locator('.table-loading-card.error')).toHaveCount(0)
  await page.screenshot({ path: `${evidenceRoot}/fallbacks/llm-surface-texture.png` })

  await page.getByRole('button', { name: '切换牌桌主题' }).click()
  await page.getByRole('menuitemradio', { name: /大模型二次元/ }).click()
  await waitForTable(page, 'llmAnime')
  await expect(page.locator('.table-loading-card.error')).toHaveCount(0)
  await page.screenshot({ path: `${evidenceRoot}/fallbacks/llmAnime-optional-textures.png` })

  expect(failedOptionalAssets).toEqual(expect.arrayContaining([
    '/img/llm-table.webp',
    '/themes/llm-anime/v1/table-felt.png',
    '/themes/llm-anime/v1/tile-back.png',
  ]))
})

test('关键牌面资源失败显示可重试错误，恢复后完成牌桌加载', async ({ page }) => {
  test.setTimeout(180_000)
  await mkdir(`${evidenceRoot}/fallbacks`, { recursive: true })
  let failTiles = true
  await page.route(/\/tiles\/[^/]+\.png$/, async (route) => {
    if (failTiles) await route.fulfill({ status: 503, body: '' })
    else await route.continue()
  })

  await page.goto('/?theme=jade', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /开始东风场/ }).click()
  const errorCard = page.locator('.table-loading-card.error')
  await expect(errorCard).toBeVisible({ timeout: 30_000 })
  await expect(errorCard).toContainText('牌桌资源加载失败')
  await expect(errorCard.getByRole('button', { name: '重试' })).toBeVisible()
  await page.screenshot({ path: `${evidenceRoot}/fallbacks/critical-tile-error.png` })

  failTiles = false
  await errorCard.getByRole('button', { name: '重试' }).click()
  await waitForTable(page, 'jade')
  await expect(errorCard).toHaveCount(0)
})

test('WebGL 初始化失败显示 DOM 回退，恢复上下文后可重试', async ({ page }) => {
  test.setTimeout(180_000)
  await mkdir(`${evidenceRoot}/fallbacks`, { recursive: true })
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    const debugWindow = window as typeof window & { __restoreWebGLContext?: () => void }
    debugWindow.__restoreWebGLContext = () => { HTMLCanvasElement.prototype.getContext = original }
    HTMLCanvasElement.prototype.getContext = function (contextId: string, ...args: unknown[]) {
      if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') return null
      return (original as (...params: unknown[]) => RenderingContext | null).call(this, contextId, ...args)
    } as typeof HTMLCanvasElement.prototype.getContext
  })

  await page.goto('/?theme=rosewood', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /开始东风场/ }).click()
  const errorCard = page.locator('.table-loading-card.error')
  await expect(errorCard).toBeVisible({ timeout: 30_000 })
  await expect(errorCard).toContainText('牌桌资源加载失败')
  await page.screenshot({ path: `${evidenceRoot}/fallbacks/webgl-error.png` })

  await page.evaluate(() => (window as typeof window & { __restoreWebGLContext?: () => void }).__restoreWebGLContext?.())
  await errorCard.getByRole('button', { name: '重试' }).click()
  await waitForTable(page, 'rosewood')
})
