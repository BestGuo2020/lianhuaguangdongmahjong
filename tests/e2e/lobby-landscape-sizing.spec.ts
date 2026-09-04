import { mkdir } from 'node:fs/promises'
import { devices, expect, test } from '@playwright/test'

const themes = ['jade', 'happyMahjong', 'rosewood', 'llm', 'llmAnime'] as const
const evidence = 'test-results/theme-presentation/landscape-sizing'

test('移动横屏两侧填满各自网格，不压窄预览或留出空白操作列', async ({ browser }) => {
  test.setTimeout(120_000)
  await mkdir(evidence, { recursive: true })
  const context = await browser.newContext({ ...devices['iPhone XR'], viewport: { width: 896, height: 414 } })
  const page = await context.newPage()
  for (const theme of themes) {
    await page.goto(`/?theme=${theme}`)
    await expect(page.locator('.theme-showcase')).toHaveAttribute('data-preview-state', 'ready')
    for (const size of [
      { width: 896, height: 414 }, { width: 844, height: 390 },
      { width: 667, height: 375 }, { width: 568, height: 320 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(size)
      await expect(page.locator('.orientation-gate')).toHaveCount(0)
      const layout = await page.evaluate(() => {
        const box = (selector: string) => {
          const r = document.querySelector(selector)!.getBoundingClientRect()
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
        }
        return {
          outer: box('.lobby-layout'), visual: box('.lobby-visual'), actions: box('.lobby-actions'),
          preview: box('.theme-showcase-frame'), start: box('.start-button'),
          subtitle: box('.start-button span'), fab: box('.llm-fab'), links: box('.lobby-links'),
          gap: parseFloat(getComputedStyle(document.querySelector('.lobby-layout')!).columnGap),
          roots: ['html', 'body', '.game-app', '.lobby'].map(selector => {
            const e = document.querySelector(selector)!
            return [e.scrollWidth - e.clientWidth, e.scrollHeight - e.clientHeight]
          }),
        }
      })
      expect(layout.actions.left - layout.visual.right, `${theme} ${size.width} column gap`).toBeCloseTo(layout.gap, 0)
      expect(layout.actions.right).toBeCloseTo(layout.outer.right, 0)
      if (theme !== 'llmAnime') {
        expect(layout.preview.width / layout.visual.width).toBeGreaterThan(.94)
        expect(layout.preview.width / layout.preview.height).toBeCloseTo(16 / 9, 1)
      }
      for (const element of [layout.visual, layout.actions, layout.preview, layout.start, layout.links]) {
        expect(element.top, `${theme} ${size.width} top`).toBeGreaterThanOrEqual(layout.outer.top - 1)
        expect(element.bottom, `${theme} ${size.width} bottom`).toBeLessThanOrEqual(layout.outer.bottom + 1)
      }
      expect(layout.links.bottom).toBeLessThanOrEqual(layout.actions.bottom + 1)
      expect(layout.subtitle.bottom).toBeLessThanOrEqual(layout.start.bottom - 2)
      expect(layout.fab.bottom).toBeLessThanOrEqual(layout.outer.top)
      for (const [x, y] of layout.roots) { expect(x).toBeLessThanOrEqual(1); expect(y).toBeLessThanOrEqual(1) }
      await page.screenshot({ path: `${evidence}/${theme}-${size.width}x${size.height}.png`, scale: 'css', animations: 'disabled' })
    }
  }
  await context.close()
})
