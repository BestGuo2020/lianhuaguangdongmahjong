import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const themes = ['jade', 'happyMahjong', 'rosewood', 'llm', 'llmAnime'] as const
const evidence = 'test-results/theme-presentation/orientation'

function luminance(channels: number[]) {
  return channels.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0)
}

test('横屏门禁五主题按钮对比度、焦点、失败提示和旋转恢复', async ({ browser }) => {
  test.setTimeout(120_000)
  await mkdir(evidence, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  // 仅模拟浏览器拒绝全屏；门禁仍依据真实视口方向和触控条件显示/退出。
  await page.addInitScript(() => {
    document.documentElement.requestFullscreen = async () => { throw new Error('Fullscreen unavailable') }
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const theme of themes) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/?theme=${theme}`)
    const gate = page.locator('.orientation-gate')
    const button = gate.getByRole('button', { name: '进入全屏横屏' })
    await expect(gate).toHaveAttribute('data-table-theme', theme)
    await expect(page.locator('.lobby')).toBeHidden()
    await expect(button).toBeEnabled()
    const colors = await button.evaluate(e => {
      const style = getComputedStyle(e)
      return { text: style.color, gradient: style.backgroundImage }
    })
    const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number)
    const text = luminance(rgb(colors.text))
    // 验证每个渐变色标；即使有透明度，其深色背景也只会提高浅色文字对比度。
    for (const stop of colors.gradient.match(/rgba?\([^)]+\)/g)!) {
      const bg = luminance(rgb(stop))
      const contrast = (Math.max(text, bg) + .05) / (Math.min(text, bg) + .05)
      expect(contrast, `${theme}: ${colors.text} on ${stop}`).toBeGreaterThanOrEqual(4.5)
    }
    await page.keyboard.press('Tab')
    await expect(button).toBeFocused()
    await expect(button).toHaveCSS('outline-style', 'solid')
    await button.click()
    await expect(gate.getByRole('status')).toHaveText('当前浏览器无法自动旋转，请将手机横置后继续')
    for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 768, height: 1024 }]) {
      await page.setViewportSize(size)
      const bounds = await gate.locator('.orientation-card').boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height)
      await page.screenshot({ path: `${evidence}/${theme}-${size.width}x${size.height}.png`, animations: 'disabled' })
    }
    await page.setViewportSize({ width: 844, height: 390 })
    await expect(gate).toHaveCount(0)
    await expect(page.locator('.lobby')).toBeVisible()
  }
  await context.close()
})
