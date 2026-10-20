import { expect, test } from '@playwright/test'

test.setTimeout(90_000)

for (const theme of ['jade', 'rosewood', 'happyMahjong', 'llm', 'llmAnime']) {
  test(`${theme}: supplied wind and rain render and play once, then expire`, async ({ page }) => {
    const errors: string[] = [], failedAssets: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (response.status() >= 400 && /yaotong-weather|angang_rainy|mingang_windy/.test(response.url())) failedAssets.push(response.url())
    })
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play
      ;(window as any).__weatherAudio = []
      HTMLMediaElement.prototype.play = function () {
        if (/sounds\/(angang|mingang)/.test(this.dataset.effectName ?? '')) (window as any).__weatherAudio.push(this)
        return play.call(this)
      }
    })
    await page.goto(`/tests/e2e/fixtures/blood-flow.html?common=1&count=0&audio=1&theme=${theme}`)
    const canvas = page.locator('canvas.mahjong-scene')
    await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
    await page.locator('main').click({ position: { x: 8, y: 8 } })
    for (const [type, kind, file, layer] of [
      ['discard-gang', 'tornado', 'sounds/mingang_windy.wav', 'table'],
      ['concealed-gang', 'rain', 'sounds/angang_rainy.wav', 'screen'],
    ]) {
      await page.evaluate(type => (window as any).__setTableActionCueLab(type, 2), type)
      await expect(canvas).toHaveAttribute('data-kong-weather', JSON.stringify([{ seat: 2, kind }]))
      expect(JSON.parse((await canvas.getAttribute('data-kong-weather-layout'))!)[0].layer).toBe(layer)
      await page.waitForTimeout(350)
      await page.screenshot({ path: `test-results/kong-weather/${theme}-${kind}.png` })
      // Clearing the transient text must not cut off the 2.2s weather animation.
      await page.evaluate(() => (window as any).__setTableActionCueLab(null))
      await expect(canvas).toHaveAttribute('data-kong-weather', JSON.stringify([{ seat: 2, kind }]))
      await expect(canvas).toHaveAttribute('data-kong-weather', '[]', { timeout: 5000 })
      await expect.poll(() => page.evaluate(file => (window as any).__weatherAudio.filter((audio: HTMLAudioElement) =>
        audio.dataset.effectName === file && audio.currentTime > 0 && audio.volume > 0 && !audio.error).length, file), { timeout: 10_000 }).toBe(1)
    }
    // Effects mute suppresses the weather sound while preserving its visual.
    await page.evaluate(() => { (window as any).__bfAudio.effectsOn.value = false })
    await page.evaluate(() => (window as any).__setTableActionCueLab('concealed-gang', 0))
    await expect(canvas).toHaveAttribute('data-kong-weather', JSON.stringify([{ seat: 0, kind: 'rain' }]))
    expect(await page.evaluate(() => (window as any).__weatherAudio.length)).toBe(2)
    expect(errors).toEqual([])
    expect(failedAssets).toEqual([])
  })
}

test('blood-flow uses completed ledger cues once and clears them on restore', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=0&viewer=2')
  const canvas = page.locator('canvas.mahjong-scene')
  await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
  await page.evaluate(() => (window as any).__appendBloodFlowKong(3, 'added'))
  await expect(canvas).toHaveAttribute('data-kong-weather', JSON.stringify([{ seat: 3, kind: 'tornado' }]))
  // Absolute seat 3 is the viewer's right-hand player (relative seat 1).
  const layout = JSON.parse((await canvas.getAttribute('data-kong-weather-layout'))!)[0]
  expect(layout.x).toBeGreaterThan(0)
  await page.evaluate(() => (window as any).__restoreBloodFlow())
  await expect(canvas).toHaveAttribute('data-kong-weather', '[]')
  await page.evaluate(() => (window as any).__appendBloodFlowKong(1, 'concealed'))
  await expect(canvas).toHaveAttribute('data-kong-weather', JSON.stringify([{ seat: 1, kind: 'rain' }]))
})

test('an added kong waits for settlement and a robbed kong never starts weather', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/blood-flow.html?common=1&count=0')
  const canvas = page.locator('canvas.mahjong-scene')
  await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
  const setPending = (robbed: boolean) => page.evaluate(robbed => {
    const players = Array.from({ length: 4 }, (_, seat) => ({ seat, name: '玩家', avatar: '', score: 2000,
      hand: [], discards: [], concealedTileCount: 10, redCount: 0, drawnTileIndex: -1,
      melds: [{ type: robbed ? 'peng' : 'gang', pending: !robbed, added: !robbed, tile: 'm1', tiles: Array(robbed ? 3 : 4).fill('m1') }] }))
    ;(window as any).__weatherPlayers = players
    ;(window as any).__setCommonPresentation({ players, user: players[0], tableActionEvent: {
      id: Date.now(), actorIndex: 0, sourceIndex: null, type: robbed ? 'robbed-kong-win' : 'added-gang', tile: 'm1', meldIndex: 0,
    } })
  }, robbed)
  await setPending(false)
  await expect(canvas).toHaveAttribute('data-kong-weather', '[]')
  await setPending(true)
  await expect(canvas).toHaveAttribute('data-kong-weather', '[]')
  await setPending(false)
  await expect(canvas).toHaveAttribute('data-kong-weather', '[]')
  await page.evaluate(() => {
    const players = (window as any).__weatherPlayers.map((p: any) => ({ ...p, melds: p.melds.map((m: any) => ({ ...m, pending: false })) }))
    ;(window as any).__setCommonPresentation({ players, user: players[0], tableActionEvent: null })
  })
  await expect(canvas).toHaveAttribute('data-kong-weather', JSON.stringify([{ seat: 0, kind: 'tornado' }]))
})

test('opposite meld row is visible with two and four groups on desktop and mobile', async ({ page }) => {
  for (const [width, height] of [[1280, 720], [844, 390]]) {
    await page.setViewportSize({ width, height })
    await page.goto('/tests/e2e/fixtures/blood-flow.html?common=1&count=0')
    await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
    for (const groups of [2, 4]) {
      await page.evaluate(groups => (window as any).__setCornerLayout(groups, null, true), groups)
      await page.waitForTimeout(250)
      await page.screenshot({ path: `test-results/kong-weather/opposite-${width}-${groups}.png` })
    }
  }
})
