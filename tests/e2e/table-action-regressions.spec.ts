import { expect, test } from '@playwright/test'

const ordinaryThemes = ['jade', 'happyMahjong', 'rosewood', 'llm']

for (const theme of ordinaryThemes) {
  test(`${theme}: each terminal win plays one text animation`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixtures/blood-flow.html?common=1&count=0&theme=${theme}`)
    await expect(page.locator('.table-loading')).toHaveCount(0)
    await page.evaluate(() => {
      (window as any).__winAnimations = []
      document.addEventListener('animationstart', event => {
        const animation = event as AnimationEvent
        if ((event.target as Element).matches('.table-action-cue.win') && !animation.pseudoElement) {
          (window as any).__winAnimations.push(animation.animationName)
        }
      })
    })
    for (const type of ['self-draw', 'discard-win']) {
      await page.evaluate(type => {
        (window as any).__winAnimations = []
        ;(window as any).__setTableActionCueLab(type, 1)
      }, type)
      await expect(page.locator(`[data-action-type="${type}"]`)).toHaveCount(1)
      // Wait past both the old .88s enter and the second .7s win animation.
      await page.waitForTimeout(1800)
      expect(await page.evaluate(() => (window as any).__winAnimations)).toHaveLength(1)
    }
  })
}

for (const common of [true, false]) {
  for (const mobile of [false, true]) {
    test(`wind kong stays horizontal: common=${common}, mobile=${mobile}`, async ({ browser }) => {
      test.setTimeout(90_000)
      const context = await browser.newContext({
        viewport: mobile ? { width: 844, height: 390 } : { width: 1280, height: 720 },
        hasTouch: mobile, isMobile: mobile,
      })
      const page = await context.newPage()
      for (const theme of [...ordinaryThemes, 'llmAnime']) {
        await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=0&theme=${theme}${common ? '&common=1' : ''}`)
        await expect(page.locator('.table-loading')).toHaveCount(0)
        await page.evaluate(() => {
          (window as any).__setCommonPresentation({ userHasWindKong: true })
          ;(window as any).__setTableActionCueLab('wind-kong', 1)
        })
        const button = page.getByRole('button', { name: '风杠', exact: true }).locator('b')
        await expect(button).toBeVisible()
        const labels = theme === 'llmAnime' ? [button] : [button, page.locator('.table-action-cue span')]
        for (const label of labels) {
          await expect(label).toHaveText('风杠')
          const sameLine = await label.evaluate(element => {
            const text = element.firstChild!
            const range = document.createRange()
            range.setStart(text, 0); range.setEnd(text, 1)
            const first = range.getBoundingClientRect()
            range.setStart(text, 1); range.setEnd(text, 2)
            const second = range.getBoundingClientRect()
            // Theme entrance animations may rotate the whole label slightly.
            return Math.abs(first.y - second.y) < Math.min(first.height, second.height) / 2 && second.x > first.x
          })
          expect(sameLine, `${theme}: ${await label.textContent()}`).toBe(true)
        }
      }
      await context.close()
    })
  }
}

test('terminal portraits survive either arrival order of win_effect and table_action', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/blood-flow.html?common=1&count=0&theme=llmAnime')
  await expect(page.locator('.table-loading')).toHaveCount(0)
  for (const effectFirst of [true, false]) {
    await page.evaluate(effectFirst => {
      (window as any).__setTableActionCueLab(null)
      ;(window as any).__setCommonPresentation({ online: true, winEffect: effectFirst ? {
        id: 1, winnerIndex: 1, tile: 'p5', duration: 2600,
        reducedMotion: false, robbedKong: false, robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1,
      } : null })
    }, effectFirst)
    await expect(page.locator('.anime-action-cue')).toHaveCount(0)
    await page.evaluate(() => (window as any).__setTableActionCueLab('self-draw', 1))
    const portrait = page.locator('.anime-action-cue[data-action-type="self-draw"]')
    await expect(portrait).toHaveCount(1)
    if (!effectFirst) {
      await page.evaluate(() => (window as any).__setCommonPresentation({ online: true, winEffect: {
        id: 2, winnerIndex: 1, tile: 'p5', duration: 2600,
        reducedMotion: false, robbedKong: false, robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1,
      } }))
    }
    await expect(portrait).toHaveCount(1)
    await expect.poll(() => portrait.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(.5)
    await expect(portrait).toHaveClass(/action-from-right/)
  }
})
