import { expect, test, type Page } from '@playwright/test'

test.setTimeout(180_000)
async function disclaimer(page: Page) {
  const button = page.getByRole('button', { name: '同意并继续', exact: true })
  try { await button.waitFor({ timeout: 2000 }); await button.click() } catch { /* already accepted in this test context */ }
}

test('real P2P lobby selects blood-flow, locks host theme and restores the client after reload', async ({ context, page: host }) => {
  const client = await context.newPage()
  const errors: string[] = []
  host.on('pageerror', e => errors.push(`host: ${e.message}`))
  client.on('pageerror', e => errors.push(`client: ${e.message}`))
  await host.goto('/?bloodFlow=1&mockPeer=blood-flow-host')
  await host.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  await host.getByRole('button', { name: /莲花麻将·血流/ }).click()
  await host.getByRole('button', { name: '确定', exact: true }).click()
  await host.getByRole('radio', { name: /联机对战/ }).click()
  await host.getByPlaceholder('输入昵称').fill('血流房主')
  await host.getByRole('button', { name: '创建房间', exact: true }).click()
  await host.getByRole('button', { name: '确认创建', exact: true }).click()
  await disclaimer(host)
  await expect(host.locator('.room-code strong')).toBeVisible({ timeout: 20_000 })
  const code = (await host.locator('.room-code strong').innerText()).trim()
  await client.goto('/?bloodFlow=1&mockPeer=blood-flow-client')
  await client.getByRole('radio', { name: /联机对战/ }).click()
  await client.getByPlaceholder('输入昵称').fill('血流客人')
  await client.getByRole('button', { name: '加入房间', exact: true }).click()
  await client.getByPlaceholder('输入 6 位房间码').fill(code)
  await client.getByRole('button', { name: '确认加入', exact: true }).click()
  await disclaimer(client)
  await expect(client.getByRole('button', { name: '准备 / 取消准备', exact: true })).toBeVisible({ timeout: 25_000 })
  await host.getByRole('button', { name: '准备 / 取消准备', exact: true }).click()
  await client.getByRole('button', { name: '准备 / 取消准备', exact: true }).click()
  await host.getByRole('button', { name: /开始对局/ }).click()
  for (const page of [host, client]) {
    await expect(page.locator('.blood-flow-pile-badge')).toHaveCount(4, { timeout: 30_000 })
    await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('.game-table-hud')).toHaveAttribute('data-opening-stage', '', { timeout: 30_000 })
    await expect(page.locator('.base-score-badge')).toContainText('底分10')
    await expect(page.locator('.game-table-hud')).toHaveAttribute('data-reveal-hands', '0')
  }
  await expect(client.getByRole('button', { name: '切换牌桌主题', exact: true })).toBeDisabled()
  const stored = await client.evaluate(async () => {
    const { createBloodFlowSessionStore } = await import('/src/game/online/vibe/bloodFlowSessionStore.ts')
    const session = createBloodFlowSessionStore(undefined, { namespace: 'mock:blood-flow-client' }).loadSession()
    return { exists: Boolean(session), rule: session?.rulesetId, hasToken: Boolean(session?.seatToken) }
  })
  expect(stored).toEqual({ exists: true, rule: 'lotus-blood-flow', hasToken: true })
  await client.reload()
  try { await expect(client.locator('.blood-flow-pile-badge')).toHaveCount(4, { timeout: 40_000 }) }
  catch (error) {
    console.log('client recovery screen:', await client.locator('main').innerText())
    console.log('client exceptions:', errors)
    throw error
  }
  await expect(client.locator('.game-table-hud')).toHaveAttribute('data-reveal-hands', '0')
  await expect(client.locator('.user-identity')).toContainText('血流客人')
  await client.screenshot({ path: 'test-results/blood-flow-p2p-rejoined.png' })
  expect(errors).toEqual([])
  await client.close()
})
