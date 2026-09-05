import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

test.setTimeout(180_000)
const sizes = [[568, 320], [844, 390], [1280, 720], [1920, 1080]]
for (const theme of ['jade', 'rosewood', 'happyMahjong', 'llm', 'llmAnime']) {
  test(`${theme}: required viewport and measured rendering environment`, async ({ page, browser }) => {
    const results: unknown[] = []
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height })
      await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=80&theme=${theme}&quality=${width < 900 ? 'low' : 'high'}`)
      await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 35_000 })
      await expect(page.locator('.blood-flow-pile-badge')).toHaveCount(4)
      const boxes = await page.locator('.blood-flow-pile-badge, .action-bar button, .hand-tile-slot').evaluateAll(elements => elements.map(element => {
        const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom }
      }))
      for (const box of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.right).toBeLessThanOrEqual(width + 1)
        expect(box.y).toBeGreaterThanOrEqual(-1); expect(box.bottom).toBeLessThanOrEqual(height + 1)
      }
      const environment = await page.locator('canvas.mahjong-scene').evaluate((canvas: HTMLCanvasElement) => {
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
        const info = gl?.getExtension('WEBGL_debug_renderer_info')
        return { userAgent: navigator.userAgent, renderer: gl && (info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
          vendor: gl && (info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)) }
      })
      expect(environment.renderer, 'GPU acceptance must not silently use a software renderer').toBeTruthy()
      expect(String(environment.renderer)).not.toMatch(/swiftshader|llvmpipe|software|basic render/i)
      await page.evaluate(() => (window as any).__appendBloodFlowWin())
      await expect(page.locator('.blood-flow-central')).toBeVisible()
      const preview = await page.locator('.blood-flow-win-card').boundingBox()
      const feedback = await page.locator('.blood-flow-central, .blood-flow-seat-feedback').evaluateAll(elements => elements.map(element => {
        const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }
      }))
      for (const box of feedback) if (preview) expect(box.x + box.width <= preview.x || preview.x + preview.width <= box.x
        || box.y + box.height <= preview.y || preview.y + preview.height <= box.y).toBe(true)
      const frameIntervals = await page.evaluate(() => new Promise<number[]>(resolve => {
        const intervals: number[] = []; let previous = performance.now()
        const sample = (now: number) => { intervals.push(now - previous); previous = now; if (intervals.length >= 45) resolve(intervals.slice(1)); else requestAnimationFrame(sample) }
        requestAnimationFrame(sample)
      }))
      frameIntervals.sort((a, b) => a - b)
      results.push({ width, height, browser: browser.version(), ...environment,
        metric: 'requestAnimationFrame interval, not GPU render duration', samples: frameIntervals.length,
        medianMs: frameIntervals[Math.floor(frameIntervals.length / 2)], p95Ms: frameIntervals[Math.floor(frameIntervals.length * .95)], maxMs: frameIntervals.at(-1) })
      await page.screenshot({ path: `test-results/blood-flow-${theme}-${width}x${height}.png` })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.evaluate(() => (window as any).__restoreBloodFlow())
      await expect(page.locator('.blood-flow-central')).toHaveCount(0)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
    }
    mkdirSync('work', { recursive: true })
    writeFileSync(`work/blood-flow-render-${theme}.json`, JSON.stringify(results, null, 2))
  })
}
