import { expect, test } from '@playwright/test'

test.setTimeout(180_000)
test('restarts from the lobby after leaving an unfinished east match', async ({page}) => {
  // Finish the first round from a valid last-turn state. Opening and re-entry
  // still use the real App/worker, and all 136 physical tiles remain accounted for.
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker
    let prepared = false
    window.Worker = class extends OriginalWorker {
      postMessage(message: any, transfer?: any) {
        if (!prepared && message.kind === 'start' && message.options?.opening) {
          prepared = true
          const opening = message.options.opening
          opening.players[0].discards.push(...opening.wall.splice(0))
        }
        super.postMessage(message, transfer ?? [])
      }
    } as typeof Worker
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', {name:/玩法 莲花广麻/}).click()
  await page.getByRole('button', {name:/莲花麻将·血流/}).click()
  await page.getByRole('button', {name:'确定',exact:true}).click()
  await page.locator('.start-button').click()
  const tiles = page.locator('.hand-tile-slot .mahjong-tile')
  await expect(tiles.last()).toBeEnabled({timeout:30000})
  await tiles.last().click()
  const summary = page.getByRole('dialog', {name:'血流本局结算'})
  await expect(summary).toBeVisible({timeout:15000})
  await expect(summary).toContainText('东1局')
  await summary.getByRole('button', {name:'返回大厅',exact:true}).click()
  await expect(page.locator('.start-button')).toBeVisible()
  // A retained HUD cannot emit another ready event after the App resets it.
  await expect(page.locator('canvas.mahjong-scene')).toHaveCount(0)
  await page.screenshot({path:'work/blood-flow-playability/restart-lobby.png'})
  await page.locator('.start-button').click()
  await expect(tiles).toHaveCount(14,{timeout:30000})
  await expect(tiles.last()).toBeEnabled({timeout:10000})
  await expect(page.locator('.round-info')).toContainText('东1局')
  await page.screenshot({path:'work/blood-flow-playability/restarted-east-one.png'})
  await tiles.last().click()
  await expect(tiles).toHaveCount(13)
  expect(errors).toEqual([])
})
test('blood-flow is available locally and in WS rooms', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  await expect(page.getByRole('button', { name: /莲花麻将·血流/ })).toBeVisible()
  await page.getByRole('button', { name: /莲花麻将·血流/ }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.locator('.start-button')).toContainText('莲花麻将·血流')
  await page.getByRole('radio', { name: /联机对战/ }).click()
  // 联机可用性断言必须跨分支成立：WS 大厅会在文案里显示当前规则，vibehub 的 P2P 大厅不显示，
  // 因此统一改为「建房弹窗的玩法选择里能选到血流」——这正是「联机可选」的实际能力。
  // 建房按钮在未填昵称时是 disabled（两个分支一致），先填昵称再打开弹窗。
  await page.getByPlaceholder('输入昵称').fill('联机校验')
  await page.getByRole('button', { name: '创建房间', exact: true }).click()
  await page.locator('.game-settings button', { hasText: '玩法' }).click()
  await expect(page.getByRole('button', { name: /莲花麻将·血流/ })).toBeVisible()
  await page.goto('/?bloodFlow=1')
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
