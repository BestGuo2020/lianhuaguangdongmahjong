import { expect, test } from '@playwright/test'

test('Kimi self and DeepSeek opponents have decoded action art before the table opens', async ({ page }) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => {
    localStorage.setItem('llm-anime.character.v1', 'kimi')
    localStorage.setItem('llm.providers', JSON.stringify({ configVersion: 2, enabled: true,
      activeId: 'deepseek', seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
      presets: [{ id: 'deepseek', name: 'DeepSeek', providerType: 'deepseek',
        baseUrl: 'https://model.example.test/v1', apiKey: 'test-only',
        model: 'deepseek-v4-flash', style: '稳健', timeoutMs: 40_000 }],
    }))
  })
  const cardRequests: string[] = []
  let releaseOthers!: () => void
  const otherGate = new Promise<void>(resolve => { releaseOthers = resolve })
  await page.route('**/themes/llm-anime/v1/characters/**', async route => {
    const url = route.request().url()
    cardRequests.push(url)
    if (!url.includes('/kimi/') && !url.includes('/deepseek/')) await otherGate
    await route.continue().catch(() => {})
  })
  await page.route('https://model.example.test/**', route => route.fulfill({ status: 503, body: 'not used by this test' }))
  try {
    await page.goto('/?theme=llmAnime&actionCueLab=peng&actionCueSeat=0')
    await page.getByRole('button', { name: /开始东风场/ }).click()
    await expect(page.locator('.game-table-hud')).toBeAttached()
    await expect(page.locator('canvas.mahjong-scene')).toBeVisible({ timeout: 45_000 })
    await expect(page.locator('.table-loading')).toBeHidden({ timeout: 45_000 })
    const active = await page.evaluate(async () => {
      const [{ materializedImageSrc }, { animeActionArtUrl }, { animeCharacterAvatarUrl }] = await Promise.all([
        import('/src/game/core/presentation/imagePreload.ts'),
        import('/src/game/core/presentation/llmAnimeAssets.ts'),
        import('/src/game/llm/animeCharacterPreference.ts'),
      ])
      return ['kimi', 'deepseek'].flatMap(id => [
        animeActionArtUrl(id, 'peng'), animeActionArtUrl(id, 'hu'), animeCharacterAvatarUrl(id),
      ]).map(url => materializedImageSrc(url))
    })
    expect(active).toHaveLength(6)
    expect(active.every(url => url?.startsWith('blob:'))).toBe(true)
    const cueImage = page.locator('.anime-action-cue img')
    await expect(cueImage).toHaveAttribute('src', active[0]!)
    expect(await cueImage.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true)
    await page.evaluate(() => (window as any).__setTableActionCueLab?.('peng', 1))
    await expect(cueImage).toHaveAttribute('src', active[3]!)
    expect(await cueImage.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true)
    expect(cardRequests).toHaveLength(4)
    expect(cardRequests.every(url => url.includes('/kimi/') || url.includes('/deepseek/'))).toBe(true)
  } finally {
    releaseOthers()
  }
})

test('an unavailable active portrait does not hold the single-player table open forever', async ({ page }) => {
  test.setTimeout(45_000)
  await page.addInitScript(() => localStorage.setItem('llm-anime.character.v1', 'kimi'))
  let releaseImage!: () => void
  const imageGate = new Promise<void>(resolve => { releaseImage = resolve })
  await page.route('**/characters/kimi/actions/call.jpg', async route => {
    await imageGate
    await route.continue().catch(() => {})
  })
  try {
    await page.goto('/?theme=llmAnime')
    await page.getByRole('button', { name: /开始东风场/ }).click()
    await expect(page.locator('.game-table-hud')).toBeAttached()
    await expect(page.locator('.table-loading')).toBeHidden({ timeout: 15_000 })
    await expect(page.locator('canvas.mahjong-scene')).toBeVisible()
  } finally {
    releaseImage()
  }
})
