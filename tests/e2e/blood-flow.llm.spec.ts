import { expect, test } from '@playwright/test'

test.setTimeout(180_000)
for (const [theme, available] of [['jade', true], ['llm', true], ['llmAnime', false]] as const) {
  test(`${theme} / model ${available ? 'available' : 'unavailable'} preserves play and gates round reactions`, async ({ page }) => {
    let decisions = 0, reactions = 0, tts = 0
    const unsafeSpeech: string[] = []
    await page.addInitScript(() => localStorage.setItem('llm.providers', JSON.stringify({ configVersion: 2, enabled: true,
      activeId: 'fixture', seatIds: [null, null, null, null], seatStyles: [null, null, null, null], presets: [{
        id: 'fixture', name: 'Fixture', providerType: 'custom', apiKey: 'not-a-real-key', baseUrl: 'https://model.example.test/v1',
        model: 'fixture-model', style: '稳健', timeoutMs: 40_000,
      }] })))
    await page.route('https://model.example.test/**', async route => {
      const body = route.request().postDataJSON()
      const isReaction = body.messages[0].content.includes('本局血流已结束')
      const payload = JSON.parse(body.messages[1].content)
      if (isReaction) {
        reactions++
        const ended = await page.evaluate(() => Boolean((window as any).__bfLlmPort?.view.value?.public.roundResult))
        if (!ended) unsafeSpeech.push('reaction before round ended')
      } else {
        decisions++
        if (payload.publicPlayers?.some((p: any) => 'hand' in p) || JSON.stringify(payload).includes('not-a-real-key')) unsafeSpeech.push('private payload')
      }
      if (!available) { await route.fulfill({ status: 503, body: 'offline' }); return }
      const choice = isReaction ? 'COMMENT' : payload.candidates[0].id
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ choice, message: isReaction ? '这一局结束了，下局再来' : '不得播放的局内自由发言', important: true, mandatory: true }),
      } }] }) })
    })
    await page.route('**/api/local-tts/synthesize', async route => { tts++; await route.fulfill({ status: 503, body: 'tts unavailable' }) })
    await page.goto('/?bloodFlow=1')
    await page.evaluate(async theme => {
      const { useBloodFlowGame } = await import('/src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts')
      const { buildRingWall } = await import('/src/game/variants/lotus/lotusWall.ts')
      const { seededRandom } = await import('/src/game/variants/lotus/bloodFlow/simulation.ts')
      const port = useBloodFlowGame({ autoplay: true, paceMs: 0, getThemeName: () => theme, playSoundAndWait: async () => {} })
      ;(window as any).__bfLlmPort = port
      await port.startGame('east', { initialWall: buildRingWall(seededRandom(91)), openingDice: [2, 3], openingSecondDice: [1, 4] })
    }, theme)
    await expect.poll(() => page.evaluate(() => (window as any).__bfLlmPort.phase.value), { timeout: 120_000, intervals: [1000] }).toBe('settled')
    expect(decisions).toBeGreaterThan(0)
    if (theme === 'jade') { expect(reactions).toBe(0); expect(tts).toBe(0) }
    else await expect.poll(() => reactions, { timeout: 20_000 }).toBe(3)
    if (theme === 'llm') {
      await expect.poll(() => tts, { timeout: 20_000 }).toBe(3)
      const texts = await page.evaluate(() => Object.values((window as any).__bfLlmPort.capabilities.value.bloodFlow.roundBubbles).map((b: any) => b.text))
      expect(texts).toHaveLength(3)
      expect(texts).not.toContain('不得播放的局内自由发言')
    }
    if (!available) {
      expect(tts).toBe(0)
      expect(await page.evaluate(() => (window as any).__bfLlmPort.llmStats.fallbacks)).toBeGreaterThan(0)
    }
    expect(unsafeSpeech).toEqual([])
    await page.evaluate(() => (window as any).__bfLlmPort.returnToLobby())
  })
}
