import { expect, test, type Page } from '@playwright/test'

test.setTimeout(240_000)
async function accept(page: Page) { const b = page.getByRole('button', { name: '同意并继续', exact: true }); try { await b.waitFor({ timeout: 1500 }); await b.click() } catch { /* test context accepted */ } }
test('only the room host requests AI decisions and round-end reactions; both viewers receive the same result', async ({ context, page: host }) => {
  const client = await context.newPage()
  let hostDecisions = 0, clientRequests = 0, reactionRequests = 0
  const ids = new Set<string>()
  await context.route('https://model.example.test/**', async route => {
    if (route.request().frame().page() !== host) clientRequests++
    const body = route.request().postDataJSON(), data = JSON.parse(body.messages[1].content)
    const reaction = body.messages[0].content.includes('本局血流已结束')
    if (reaction) reactionRequests++
    else {
      hostDecisions++
      expect([2, 3]).toContain(data.seat)
      expect(ids.has(data.requestId)).toBe(false); ids.add(data.requestId)
      expect(data.publicPlayers.every((p: any) => !('hand' in p))).toBe(true)
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ choice: reaction ? 'COMMENT' : data.candidates[0].id, message: reaction ? '本局结束，下局再来' : '不要播出的自由发言' }),
    } }] }) })
  })
  await context.route('**/api/local-tts/synthesize', route => route.fulfill({ status: 503, body: 'test TTS failure' }))
  await host.addInitScript(() => localStorage.setItem('llm.providers', JSON.stringify({ configVersion: 2, enabled: true, activeId: 'bf-model',
    seatIds: [null, null, null, null], seatStyles: [null, null, null, null], presets: [{ id: 'bf-model', name: 'Test', providerType: 'custom',
      apiKey: 'test-only-private-key', baseUrl: 'https://model.example.test/v1', model: 'fixture-model', style: '稳健', timeoutMs: 40_000 }] })))
  await host.goto('/?bloodFlow=1&theme=llm&mockPeer=bf-model-host')
  await host.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  await host.getByRole('button', { name: /莲花麻将·血流/ }).click()
  await host.getByRole('button', { name: '确定', exact: true }).click()
  await host.getByRole('radio', { name: /联机对战/ }).click()
  await host.getByPlaceholder('输入昵称').fill('模型房主')
  await host.getByRole('button', { name: '创建房间', exact: true }).click()
  await host.getByRole('button', { name: '确认创建', exact: true }).click(); await accept(host)
  await expect(host.locator('.room-code strong')).toBeVisible({ timeout: 20_000 })
  const code = await host.locator('.room-code strong').innerText()
  await client.goto('/?bloodFlow=1&mockPeer=bf-model-client')
  await client.getByRole('radio', { name: /联机对战/ }).click(); await client.getByPlaceholder('输入昵称').fill('模型客人')
  await client.getByRole('button', { name: '加入房间', exact: true }).click()
  await client.getByPlaceholder('输入 6 位房间码').fill(code.trim())
  await client.getByRole('button', { name: '确认加入', exact: true }).click(); await accept(client)
  await expect(client.getByRole('button', { name: '准备 / 取消准备', exact: true })).toBeVisible({ timeout: 25_000 })
  await expect(host.locator('.room-seat')).toContainText(['模型房主', '模型客人', '', ''], { timeout: 15_000 })
  const picks = host.getByTestId('room-llm-pick')
  await expect(picks).toHaveCount(2)
  await picks.nth(0).selectOption({ index: 1 }); await picks.nth(1).selectOption({ index: 1 })
  for (const page of [host, client]) await page.getByRole('button', { name: '准备 / 取消准备', exact: true }).click()
  await host.getByRole('button', { name: /开始对局/ }).click()
  for (const page of [host, client]) {
    await expect(page.locator('.blood-flow-pile-badge')).toHaveCount(4, { timeout: 30_000 })
    await expect(page.locator('.game-table-hud')).toHaveAttribute('data-opening-stage', '', { timeout: 30_000 })
    await page.getByRole('button', { name: /开启机器人托管/ }).click()
  }
  for (const page of [host, client]) await expect(page.getByRole('dialog', { name: '血流公开流水' })).toBeVisible({ timeout: 150_000 })
  expect(hostDecisions).toBeGreaterThan(0)
  expect(clientRequests).toBe(0)
  await expect.poll(() => reactionRequests, { timeout: 20_000 }).toBe(2)
  expect(await client.locator('.blood-flow-ledger tbody').innerText()).toBe(await host.locator('.blood-flow-ledger tbody').innerText())
  await client.close()
})
