import { expect, test } from '@playwright/test'
import { LLM_DRAW_LINES } from '../../src/game/llm/winLines'
import { BLOOD_FLOW_LOSS_LINES, BLOOD_FLOW_WIN_LINES } from '../../src/game/llm/bloodFlowRoundLines'
// 血流自 2026-09-08 起赢家/输家用血流专属台词库（荒庄仍用共享库），期望集合必须跟着改——
// 此前这里只取共享 winLines，导致「局末台词 TTS > 0」永远匹配不到（断言过期，非产品问题）。
const roundLines=new Set([...Object.values(BLOOD_FLOW_WIN_LINES).flatMap(s=>s.稳健),...BLOOD_FLOW_LOSS_LINES.稳健,...LLM_DRAW_LINES.稳健].map(t=>t.normalize('NFKC')))

test.setTimeout(180_000)
for (const [theme, available] of [['jade', true], ['llm', true], ['llmAnime', false]] as const) {
  test(`${theme} / model ${available ? 'available' : 'unavailable'} preserves play and gates round reactions`, async ({ page }) => {
    let decisions = 0, reactions = 0, tts = 0, roundTts = 0, winTts = 0, protectedDecisions = 0
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
        const protectedTiles = [...payload.jokerTiles, '白板']
        if (!payload.locked && payload.hand.some((t: string) => protectedTiles.includes(t))
          && payload.hand.some((t: string) => !protectedTiles.includes(t))) {
          protectedDecisions++
          for (const candidate of payload.candidates) if (candidate.label.startsWith('打出')) {
            expect(protectedTiles).not.toContain(candidate.label.slice(2))
          }
        }
        if (payload.publicPlayers?.some((p: any) => 'hand' in p) || JSON.stringify(payload).includes('not-a-real-key')) unsafeSpeech.push('private payload')
      }
      if (!available) { await route.fulfill({ status: 503, body: 'offline' }); return }
      const choice = isReaction ? 'COMMENT' : payload.candidates[0].id
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ choice, message: isReaction ? '这一局结束了，下局再来' : payload.currentWin ? '这把稳了。' : '这张先走。', important: true, mandatory: true }),
      } }] }) })
    })
    await page.route('**/api/local-tts/synthesize', async route => {
      const body = route.request().postDataJSON()
      tts++
      if (roundLines.has(body.text)) roundTts++
      if (body.text === '这把稳了。') winTts++
      await route.fulfill({ status: 503, body: 'tts unavailable' })
    })
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
    expect(protectedDecisions).toBeGreaterThan(0)
    // 大模型赢家在所有主题都用自己的台词 TTS（对齐非血流，含 jade）；
    // llmAnime 走角色固定台词（文本不在 winTts 计数内），模型不可用时回退原逻辑。
    if (available && theme !== 'llmAnime') expect(winTts).toBeGreaterThan(0)
    expect(reactions).toBe(0) // Round lines come from the original library, never COMMENT requests.
    if (theme !== 'jade') {
      await expect.poll(() => roundTts, { timeout: 20_000 }).toBeGreaterThan(0)
      const texts = await page.evaluate(() => Object.values((window as any).__bfLlmPort.capabilities.value.bloodFlow.roundBubbles).map((b: any) => b.text))
      expect(texts).toHaveLength(3)
      for (const text of texts) expect(roundLines.has(String(text).normalize('NFKC'))).toBe(true)
      expect(await page.evaluate(() => Object.keys((window as any).__bfLlmPort.capabilities.value.bloodFlow.actionBubbles))).toEqual([])
    }
    if (!available) {
      // Model failures still allow the original fixed round lines and TTS fallback.
      expect(await page.evaluate(() => (window as any).__bfLlmPort.llmStats.fallbacks)).toBeGreaterThan(0)
    }
    expect(unsafeSpeech).toEqual([])
    await page.evaluate(() => (window as any).__bfLlmPort.returnToLobby())
  })
}
