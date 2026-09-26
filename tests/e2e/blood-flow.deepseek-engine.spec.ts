import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const configFile = process.env.BLOOD_FLOW_DEEPSEEK_CONFIG
test.use({ trace: 'off' })

test('real DeepSeek seats complete all four local blood-flow east rounds', async ({ page }) => {
  test.skip(!configFile, 'Set BLOOD_FLOW_DEEPSEEK_CONFIG to a local LLM settings JSON file')
  test.setTimeout(2_400_000)
  const saved = JSON.parse(readFileSync(configFile!, 'utf8')) as {
    presets: Array<{ id: string; providerType?: string; model: string; apiKey: string; baseUrl: string }>
  }
  const requestedModel = process.env.BLOOD_FLOW_DEEPSEEK_MODEL
  const preset = saved.presets.find(item => item.providerType === 'deepseek'
    && (!requestedModel || item.model === requestedModel))
  expect(preset?.apiKey).toBeTruthy()
  await page.addInitScript(value => localStorage.setItem('llm.providers', JSON.stringify(value)), {
    configVersion: 2, enabled: true, presets: [preset], activeId: preset!.id,
    seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
  })
  let requests = 0
  let successes = 0
  page.on('request', request => { if (request.url().startsWith('https://api.deepseek.com/')) requests++ })
  page.on('response', response => { if (response.url().startsWith('https://api.deepseek.com/') && response.ok()) successes++ })
  await page.goto('/?bloodFlow=1&theme=jade')
  await page.evaluate(async () => {
    const [{ useBloodFlowGame }, { buildRingWall }, { seededRandom }] = await Promise.all([
      import('/src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts'),
      import('/src/game/variants/lotus/lotusWall.ts'),
      import('/src/game/variants/lotus/bloodFlow/simulation.ts'),
    ])
    const game = useBloodFlowGame({ autoplay: true, paceMs: 0, countdownEnabled: false,
      getThemeName: () => 'jade', playSoundAndWait: async () => {} })
    ;(window as any).__deepseekEngineGame = game
    await game.startGame('east', { initialWall: buildRingWall(seededRandom(91)),
      openingDice: [2, 3], openingSecondDice: [1, 4] })
  })
  const rounds: number[] = []
  for (let round = 1; round <= 4; round++) {
    await expect.poll(() => page.evaluate(() => {
      const game = (window as any).__deepseekEngineGame
      return { round: game.round.value, phase: game.phase.value,
        status: game.view.value?.public.status ?? '' }
    }), { timeout: 480_000, intervals: [1000] }).toEqual({ round, phase: 'settled', status: 'settled' })
    const stats = await page.evaluate(() => {
      const game = (window as any).__deepseekEngineGame
      return { scores: game.players.map((player: { score: number }) => player.score),
        llm: { ...game.llmStats }, matchFinished: game.matchFinished.value }
    })
    rounds.push(round)
    console.log(`[deepseek-engine] round=${round}, model requests=${requests}, ok=${successes}, llm requests=${stats.llm.requests}, successes=${stats.llm.successes}, fallbacks=${stats.llm.fallbacks}`)
    expect(stats.scores.reduce((sum: number, score: number) => sum + score, 0)).toBe(8000)
    if (round < 4) {
      expect(stats.matchFinished).toBe(false)
      await page.evaluate(async (next) => {
        const [{ buildRingWall }, { seededRandom }] = await Promise.all([
          import('/src/game/variants/lotus/lotusWall.ts'),
          import('/src/game/variants/lotus/bloodFlow/simulation.ts'),
        ])
        await (window as any).__deepseekEngineGame.nextRound({ initialWall: buildRingWall(seededRandom(91 + next)),
          openingDice: [2, 3], openingSecondDice: [1, 4] })
      }, round + 1)
    } else expect(stats.matchFinished).toBe(true)
  }
  expect(rounds).toEqual([1, 2, 3, 4])
  expect(requests).toBeGreaterThan(0)
  expect(successes).toBeGreaterThan(0)
})
