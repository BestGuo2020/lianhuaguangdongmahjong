import { expect, test } from '@playwright/test'
import { LLM_DRAW_LINES } from '../../src/game/llm/winLines'
import { BLOOD_FLOW_LOSS_LINES, BLOOD_FLOW_WIN_LINES } from '../../src/game/llm/bloodFlowRoundLines'
import { BLOOD_FLOW_MOMENT_LINES } from '../../src/game/llm/bloodFlowWinLines'
import { ANIME_CHARACTERS, ANIME_RESULT_VOICE_KEYS } from '../../src/game/llm/animeCharacters'
// 血流自 2026-09-08 起赢家/输家用血流专属台词库（荒庄仍用共享库），期望集合必须跟着改——
// 此前这里只取共享 winLines，导致「局末台词 TTS > 0」永远匹配不到（断言过期，非产品问题）。
const roundLines=new Set([...Object.values(BLOOD_FLOW_WIN_LINES).flatMap(s=>s.稳健),...BLOOD_FLOW_LOSS_LINES.稳健,...LLM_DRAW_LINES.稳健].map(t=>t.normalize('NFKC')))
// llmAnime 在血流里的局末感言自 2026-09-19 起改用角色专属固定文案（win-self-draw / win-discard /
// win-robbed-kong / loss / draw），与经典玩法同一批键；期望集合按角色合同生成。
const animeRoundLines=new Set(ANIME_CHARACTERS.flatMap(character=>ANIME_RESULT_VOICE_KEYS.map(key=>character.lines[key].normalize('NFKC'))))
// 胡牌瞬间的即时台词库（锁手连胡等未走模型的窗口）：llm 主题赢家至少要说出一句其中的台词。
const momentLines=new Set(Object.values(BLOOD_FLOW_MOMENT_LINES).flatMap(groups=>Object.values(groups).flat()).map(t=>t.normalize('NFKC')))
// 台词 → 档位：用来验证一局里「自摸 / 吃胡」真的听得出区别（连胡档只在同源连续时才接管）。
const momentGroupOf=new Map(Object.entries(BLOOD_FLOW_MOMENT_LINES)
  .flatMap(([group,styles])=>Object.values(styles).flat().map(text=>[text.normalize('NFKC'),group] as const)))

// 座位 1-3 按真实接入方式声明为大模型座位（App.vue 传 `localLlmSeeds`）：不传种子时
// `isLlmWinner` 恒为 false，赢家既不出声也不出气泡，胡牌台词只走到预合成，验收不到真行为。
const LLM_SEEDS = ['deepseek', 'qwen', 'gpt'].map((characterId, index) => ({
  name: `Fixture${index + 1}`, avatar: '', isLlm: true, characterId, playerKind: 'llm' as const,
}))

test.setTimeout(180_000)
for (const [theme, available] of [['jade', true], ['llm', true], ['llmAnime', false]] as const) {
  test(`${theme} / model ${available ? 'available' : 'unavailable'} preserves play and gates round reactions`, async ({ page }) => {
    let decisions = 0, reactions = 0, tts = 0, roundTts = 0, animeRoundTts = 0, momentTts = 0, protectedDecisions = 0
    const momentTexts = new Set<string>()
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
        // Non-joker whiteboards participate in discard evaluation; only actual jokers are protected.
        const protectedTiles = [...payload.jokerTiles]
        if (!payload.locked && payload.hand.some((t: string) => protectedTiles.includes(t))
          && payload.hand.some((t: string) => !protectedTiles.includes(t))) {
          protectedDecisions++
          for (const candidate of payload.candidates) if (candidate.label.startsWith('打出')) {
            expect(protectedTiles).not.toContain(candidate.label.slice(2))
          }
        }
        if (payload.publicPlayers?.some((p: any) => 'hand' in p) || JSON.stringify(payload).includes('not-a-real-key')) unsafeSpeech.push('private payload')
        if (payload.bigHandRoute?.committed) {
          expect(payload.ruleSummary).not.toContain('候选里不会出现')
          if (payload.candidates.some((c: { label: string }) => c.label.startsWith('胡牌'))) {
            expect(payload.ruleSummary).toContain('胡牌仍可选择')
          }
        }
      }
      if (!available) { await route.fulfill({ status: 503, body: 'offline' }); return }
      const choice = isReaction ? 'COMMENT' : payload.candidates[0].id
      // 胡牌窗口故意不给 message：真实对局里锁手连胡、单候选窗口同样不请求模型，
      // 这条路径必须落到血流即时台词库（模型原话优先由单测 `bloodFlowCommonDecision` 锁定）。
      const message = isReaction ? '这一局结束了，下局再来' : payload.currentWin ? '' : '这张先走。'
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ choice, message, important: true, mandatory: true }),
      } }] }) })
    })
    await page.route('**/api/local-tts/synthesize', async route => {
      const body = route.request().postDataJSON()
      tts++
      if (roundLines.has(body.text)) roundTts++
      if (animeRoundLines.has(body.text)) animeRoundTts++
      if (momentLines.has(body.text.normalize('NFKC'))) { momentTts++; momentTexts.add(body.text.normalize('NFKC')) }
      await route.fulfill({ status: 503, body: 'tts unavailable' })
    })
    await page.goto('/?bloodFlow=1')
    await page.evaluate(async ({ theme, seeds }) => {
      // 记录整局出现过的牌桌气泡文字：胡牌瞬间的即时台词必须真的落到气泡通道
      // （2026-09-19 之前赢家台词只有声音，牌桌上什么都看不到）。
      const seen = new Set<string>()
      ;(window as any).__bfSeenBubbles = seen
      setInterval(() => {
        const bubbles = (window as any).__bfLlmPort?.capabilities?.value?.bloodFlow?.actionBubbles
        if (bubbles) for (const bubble of Object.values(bubbles) as { text: string }[]) seen.add(bubble.text)
      }, 50)
      const { useBloodFlowGame } = await import('/src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts')
      const { buildRingWall } = await import('/src/game/variants/lotus/lotusWall.ts')
      const { seededRandom } = await import('/src/game/variants/lotus/bloodFlow/simulation.ts')
      const port = useBloodFlowGame({ autoplay: true, paceMs: 0, getThemeName: () => theme, playSoundAndWait: async () => {}, aiPlayerSeeds: seeds })
      ;(window as any).__bfLlmPort = port
      await port.startGame('east', { initialWall: buildRingWall(seededRandom(91)), openingDice: [2, 3], openingSecondDice: [1, 4] })
    }, { theme, seeds: LLM_SEEDS })
    await expect.poll(() => page.evaluate(() => (window as any).__bfLlmPort.phase.value), { timeout: 120_000, intervals: [1000] }).toBe('settled')
    expect(decisions).toBeGreaterThan(0)
    expect(protectedDecisions).toBeGreaterThan(0)
    // 胡牌窗口台词：llmAnime 走角色固定台词；其余主题的胡牌瞬间必须落在血流即时台词库
    // （按胡法/档位/序号轮换），并且这句话真的显示成气泡。
    if (available && theme !== 'llmAnime') {
      expect(momentTts).toBeGreaterThan(0)
      // 2026-09-19 评审修正：连胡档曾按胡牌序号直接接管，第 3 胡后自摸/吃胡又听不出区别。
      // 同源连胡后，一局里必须同时出现至少两个「胡法基础档」的台词（自摸 / 点炮 / 抢杠 / 杠后自摸）。
      const sourceGroups = new Set([...momentTexts].map(text => momentGroupOf.get(text))
        .filter(group => group !== undefined && ['self-draw', 'discard-win', 'robbed-kong-win', 'kong-bloom-win'].includes(group)))
      expect(sourceGroups.size).toBeGreaterThanOrEqual(2)
      const seen = await page.evaluate(() => [...((window as any).__bfSeenBubbles as Set<string>)])
      expect(seen.some(text => momentLines.has(String(text).normalize('NFKC')))).toBe(true)
    }
    expect(reactions).toBe(0) // Round lines come from the original library, never COMMENT requests.
    if (theme !== 'jade') {
      const expectedRoundLines = theme === 'llmAnime' ? animeRoundLines : roundLines
      await expect.poll(() => theme === 'llmAnime' ? animeRoundTts : roundTts, { timeout: 20_000 }).toBeGreaterThan(0)
      const texts = await page.evaluate(() => Object.values((window as any).__bfLlmPort.capabilities.value.bloodFlow.roundBubbles).map((b: any) => b.text))
      expect(texts).toHaveLength(3)
      for (const text of texts) expect(expectedRoundLines.has(String(text).normalize('NFKC'))).toBe(true)
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
