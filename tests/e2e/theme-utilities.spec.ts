import { expect, test, type Locator } from '@playwright/test'

const themes = ['jade', 'happyMahjong', 'rosewood', 'llm', 'llmAnime']

// Check rendered foregrounds (including placeholders), alpha layers and gradient endpoints.
// This catches specificity regressions that a palette/token equality check cannot detect.
async function readableText(surface: Locator) {
  await expect.poll(() => surface.evaluate(root => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const parse = (color: string) => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1)
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).map((value, i) => i === 3 ? value / 255 : value)
    }
    const over = (a: number[], b: number[]) => [...a.slice(0, 3).map((v, i) => v * a[3]! + b[i]! * (1 - a[3]!)), 1]
    const luminance = (color: number[]) => color.slice(0, 3).map(v => v / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0)
    const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
    const failures: string[] = []
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      if (el.closest('button:disabled, select:disabled, option, .sr-only') || !el.getClientRects().length) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden') continue
      const field = el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el : null
      const text = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent?.trim()).join(' ')
        || (field?.value || (field instanceof HTMLInputElement ? field.placeholder : ''))
      if (!text?.trim()) continue
      const placeholder = field instanceof HTMLInputElement && !field.value && field.placeholder
      const foregroundStyle = getComputedStyle(el, placeholder ? '::placeholder' : undefined)
      const foreground = parse(foregroundStyle.color)
      if (placeholder) foreground[3]! *= Number(foregroundStyle.opacity)
      const chain: Element[] = []
      for (let ancestor: Element | null = el; ancestor; ancestor = ancestor.parentElement) chain.unshift(ancestor)
      let backgrounds = [[255, 255, 255, 1]]
      for (const ancestor of chain) {
        const s = getComputedStyle(ancestor)
        foreground[3]! *= Number(s.opacity)
        backgrounds = backgrounds.map(bg => over(parse(s.backgroundColor), bg))
        const stops = s.backgroundImage.match(/(?:rgba?\([^)]*\)|color\([^)]*\)|#[a-fA-F0-9]{3,8})/g)
        if (stops) backgrounds = backgrounds.flatMap(bg => stops.map(color => over(parse(color), bg)))
        if (backgrounds.length > 4) {
          backgrounds.sort((a, b) => luminance(a) - luminance(b))
          backgrounds = [backgrounds[0]!, backgrounds.at(-1)!]
        }
      }
      const minimum = Math.min(...backgrounds.map(bg => contrast(over(foreground, bg), bg)))
      // Require 4.5 even for large headings; conservatively check the brightest gradient stop.
      if (minimum < 4.5) failures.push(`${el.tagName}.${el.className} ${text.slice(0, 45)}: ${minimum.toFixed(2)}:1`)
    }
    return failures
  }), { timeout: 10_000 }).toEqual([])
}
async function tokenColor(locator: Locator, property: string, token: string, pseudo?: string) {
  await expect.poll(() => locator.evaluate((element, args) => {
    const actual = getComputedStyle(element, args.pseudo).getPropertyValue(args.property)
    const probe = document.createElement('span')
    probe.style.color = `var(${args.token})`; element.append(probe)
    const expected = getComputedStyle(probe).color; probe.remove()
    return actual === expected ? 'matched' : `${args.property}: ${actual}; ${args.token}: ${expected}`
  }, { property, token, pseudo }), { timeout: 10000 }).toBe('matched')
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 667, height: 375 }]) {
  test(`utility surfaces follow five themes while open ${viewport.width}`, async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 800, isMobile: viewport.width < 800 })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await page.addInitScript(() => localStorage.setItem('lianhua-guangma:audio-preferences:v1', JSON.stringify({ soundOn: true, bgmOn: false, effectsOn: false })))
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/players/**', route => route.fulfill({
      headers: { 'Access-Control-Allow-Origin': route.request().headers().origin ?? new URL(page.url()).origin,
        'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,OPTIONS' },
      json: { matches: 4, hands: 16, wins: 5, totalDelta: 300 },
    }))
    await page.goto('/tests/e2e/fixtures/theme-utilities.html', { timeout: 60_000 })
    for (const surface of ['rules', 'stats', 'replay', 'llm', 'ledger', 'room', 'audio', 'round', 'final', 'timeline', 'info']) {
      await page.getByTestId('utility-surface').selectOption(surface)
      const surfaces = { rules: '.rules-panel', stats: '.stats-card', replay: '.replay-list-card', llm: '.llm-panel', ledger: '.blood-flow-ledger', room: '.room-panel', round: '.bf-round-summary', final: '.bf-final-ranking', timeline: '.replay-timeline', info: '.replay-info', audio: '.audio-menu' }
      for (const [name, selector] of Object.entries(surfaces)) {
        if (name === 'audio') continue
        if (name !== surface) await expect(page.locator(selector)).toBeHidden()
      }
      if (surface === 'llm') {
        await page.getByTestId('llm-add').click()
        await page.getByTestId('llm-provider-type').selectOption('custom')
        await page.getByTestId('llm-base-url').fill('https://example.invalid')
        await page.getByTestId('llm-model').fill('theme-audit-unknown-model')
      }
      if (surface === 'audio') {
        await page.getByRole('button', { name: '声音设置', exact: true }).click()
      }
      if (surface === 'info') await page.getByTestId('replay-info-toggle').click()
      for (const theme of themes) {
        await page.getByTestId('utility-theme').selectOption(theme)
        await expect(page.locator('.game-app')).toHaveAttribute('data-table-theme', theme)
        if (surface === 'rules') {
          await tokenColor(page.locator('.rule-list article > b').first(), 'color', '--theme-accent-text')
          await tokenColor(page.locator('.rules-panel header button'), 'color', '--theme-text')
          if (viewport.width < 800) await tokenColor(page.locator('.rules-panel header'), 'background-color', '--theme-panel-elevated')
        } else if (surface === 'stats') {
          await tokenColor(page.locator('.stats-grid b').first(), 'color', '--theme-text')
          await tokenColor(page.locator('.stats-grid b.positive'), 'color', '--theme-positive')
          await tokenColor(page.locator('.stats-grid article').first(), 'background-color', '--theme-panel-elevated')
        } else if (surface === 'replay') {
          await tokenColor(page.locator('.replay-list-card h2'), 'color', '--theme-text')
          await tokenColor(page.locator('.replay-row-actions button').first(), 'color', '--theme-text')
          await tokenColor(page.locator('.replay-list-settings button').first(), 'color', '--theme-text')
          await tokenColor(page.locator('.replay-row-version'), 'color', '--theme-warning')
          await tokenColor(page.locator('.replay-row-analysis[data-analysis-status="partial"]'), 'color', '--theme-warning')
          await tokenColor(page.locator('.replay-row-analysis[data-analysis-status="complete"]'), 'color', '--theme-accent-text')
        } else if (surface === 'llm') {
          await tokenColor(page.getByTestId('llm-unknown-model-warning'), 'color', '--theme-warning')
          await expect(page.getByTestId('llm-model')).toHaveValue('theme-audit-unknown-model')
        } else if (surface === 'ledger') {
          await tokenColor(page.locator('.ledger-primary'), 'color', '--theme-text')
          await tokenColor(page.locator('.ledger-primary'), 'border-top-color', '--theme-accent')
          const background = await page.locator('.ledger-primary').evaluate(element => getComputedStyle(element).backgroundColor)
          expect(background).not.toBe('rgb(230, 196, 130)')
        } else if (surface === 'room') {
          await tokenColor(page.locator('.room-llm-note.off'), 'color', '--theme-warning')
          await page.getByTestId('utility-room-state').click()
          await tokenColor(page.locator('.room-llm-note.on'), 'color', '--theme-positive')
          await page.getByTestId('utility-room-state').click()
        } else if (surface === 'audio') {
          if (!await page.locator('.audio-menu').isVisible()) await page.getByRole('button', { name: '声音设置', exact: true }).click()
          await tokenColor(page.locator('.audio-menu i:not(.active)').first(), 'background-color', '--theme-panel-elevated')
          await tokenColor(page.locator('.audio-menu i:not(.active)').first(), 'background-color', '--theme-text-muted', '::after')
        }
        await readableText(page.locator(surfaces[surface as keyof typeof surfaces]))
        if (['rules', 'stats', 'ledger', 'replay', 'round', 'final', 'timeline', 'llm'].includes(surface) && ['happyMahjong', 'llm', 'llmAnime', 'rosewood'].includes(theme)) {
          await page.screenshot({ path: `test-results/theme-utility-${viewport.width}-${surface}-${theme}.png`, animations: 'disabled' })
        }
      }
      if (surface === 'audio') {
        await page.getByRole('button', { name: '声音设置', exact: true }).click()
        await expect(page.locator('.audio-menu')).toBeHidden()
      }
    }
    expect(errors).toEqual([])
    await context.close()
  })
}
