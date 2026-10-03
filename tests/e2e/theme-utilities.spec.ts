import { expect, test, type Locator } from '@playwright/test'

const themes = ['jade', 'happyMahjong', 'rosewood', 'llm', 'llmAnime']
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
    for (const surface of ['rules', 'stats', 'replay', 'llm', 'ledger', 'room', 'audio']) {
      await page.getByTestId('utility-surface').selectOption(surface)
      for (const [name, selector] of Object.entries({ rules: '.rules-panel', stats: '.stats-card', replay: '.replay-list-card', llm: '.llm-panel', ledger: '.blood-flow-ledger', room: '.room-panel' })) {
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
      for (const theme of themes) {
        await page.getByTestId('utility-theme').selectOption(theme)
        await expect(page.locator('.game-app')).toHaveAttribute('data-table-theme', theme)
        if (surface === 'rules') {
          await tokenColor(page.locator('.rule-list article > b').first(), 'color', '--theme-accent')
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
          await tokenColor(page.locator('.replay-row-analysis[data-analysis-status="complete"]'), 'color', '--theme-accent')
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
        if (['rules', 'stats', 'ledger', 'replay'].includes(surface) && ['llm', 'llmAnime', 'rosewood'].includes(theme)) {
          await page.screenshot({ path: `test-results/theme-utility-${viewport.width}-${surface}-${theme}.png`, animations: 'disabled' })
        }
      }
    }
    expect(errors).toEqual([])
    await context.close()
  })
}
