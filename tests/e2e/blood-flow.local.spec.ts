import { expect, test } from '@playwright/test'

test.setTimeout(180_000)
test('blood-flow is opt-in locally and cannot enter a WS room', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  await expect(page.getByRole('button', { name: /莲花麻将·血流/ })).toHaveCount(0)
  await page.goto('/?bloodFlow=1')
  await page.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  await page.getByRole('button', { name: /莲花麻将·血流/ }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.locator('.start-button')).toContainText('莲花麻将·血流')
  await page.getByRole('radio', { name: /联机对战/ }).click()
  await expect(page.locator('.remote-lobby')).not.toContainText('莲花麻将·血流')
  await page.getByRole('radio', { name: /单机对战/ }).click()
  await page.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  await page.getByRole('button', { name: /莲花麻将·血流/ }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await page.locator('.start-button').click()
  await expect(page.locator('canvas.mahjong-scene')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.base-score-badge')).toContainText('底分10')
  await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(13)
  await page.screenshot({ path: 'test-results/blood-flow-local-opening.png' })
  expect(errors).toEqual([])
})

for (const mode of ['east', 'hanchan'] as const) {
  test(`actual worker and Vue adapter complete a fixed-seed ${mode} match`, async ({ page }) => {
    await page.goto('/?bloodFlow=1')
    await page.evaluate(async mode => {
      const module = await import('/src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts')
      const { buildRingWall } = await import('/src/game/variants/lotus/lotusWall.ts')
      const { seededRandom } = await import('/src/game/variants/lotus/bloodFlow/simulation.ts')
      const game = module.useBloodFlowGame({ autoplay: true, paceMs: 0, playSoundAndWait: async () => {} })
      const evidence = { done: false, error: '', rounds: [] as number[], scores: [] as number[] }
      ;(window as any).__bloodFlowEvidence = evidence
      await game.startGame(mode, { initialWall: buildRingWall(seededRandom(83)), openingDice: [2, 3], openingSecondDice: [1, 4] })
      const timer = window.setInterval(() => {
        if (game.view.value?.public.status === 'interrupted') {
          evidence.error = 'worker interrupted'; window.clearInterval(timer); game.returnToLobby()
        } else if (game.phase.value === 'settled') {
          evidence.rounds.push(game.round.value)
          if (game.matchFinished.value) {
            evidence.scores = game.players.map(p => p.score); evidence.done = true
            window.clearInterval(timer); game.returnToLobby()
          } else {
            // Supply fixed random state for every round without replacing the engine.
            const next = game.round.value + 1
            void game.nextRound({ initialWall: buildRingWall(seededRandom(83 + next)), openingDice: [2, 3], openingSecondDice: [1, 4] })
          }
        }
      }, 20)
    }, mode)
    await expect.poll(() => page.evaluate(() => (window as any).__bloodFlowEvidence), { timeout: 150_000, intervals: [1000] })
      .toMatchObject({ done: true, error: '' })
    const result = await page.evaluate(() => (window as any).__bloodFlowEvidence)
    expect(result.rounds).toEqual(Array.from({ length: mode === 'east' ? 4 : 8 }, (_, i) => i + 1))
    expect(result.scores.reduce((a: number, b: number) => a + b, 0)).toBe(8000)
  })
}
