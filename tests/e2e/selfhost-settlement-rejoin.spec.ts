// 公网 2 真人 + 2 AI：在单局结算层刷新客端，验证恢复的仍是当前结算，
// 不误入最终排名；两端确认后必须继续到下一手。
import { expect, test, type Page } from '@playwright/test'

const SIGNALING = 'wss://www.bestguo.top:58787'
const TURN = 'turn:turn:DZxaEm35GmecFZj@113.45.254.130:53478'
const APP = `http://127.0.0.1:5173/?selfHost=${SIGNALING}&turn=${TURN}&manualContinue=1`
const APP_AUTO = `${APP}&auto=1`

test.describe.configure({ mode: 'serial' })
test.setTimeout(900_000)

async function enterRemoteLobby(page: Page, nickname: string, app: string) {
  await page.goto(app)
  await page.getByRole('radio', { name: /联机对战/ }).click()
  await page.getByPlaceholder('输入昵称').fill(nickname)
}

async function acceptDisclaimerIfShown(page: Page) {
  const accept = page.getByRole('button', { name: '同意并继续' })
  try {
    await accept.waitFor({ state: 'visible', timeout: 3000 })
    await accept.click()
  } catch {
    // 已同意过时不会弹窗。
  }
}

async function installHostAutoPlayer(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as { __settlementRejoinAuto?: number }
    if (state.__settlementRejoinAuto) return
    state.__settlementRejoinAuto = window.setInterval(() => {
      const actionBar = document.querySelector('.action-bar')
      if (actionBar) {
        const hu = actionBar.querySelector<HTMLButtonElement>('.action.hu')
        if (hu) { hu.click(); return }
        const pass = actionBar.querySelector<HTMLButtonElement>('.action.pass')
        if (pass) { pass.click(); return }
      }
      const tile = document.querySelector<HTMLElement>('.hand-rack.playable .hand-tile-slot .mahjong-tile')
      tile?.click()
    }, 120)
  })
}

async function clickContinue(page: Page) {
  const button = page.locator('.round-settlement .result-actions button').filter({ hasText: /^继续/ }).first()
  await expect(button).toBeVisible({ timeout: 30_000 })
  await expect(button).toBeEnabled({ timeout: 30_000 })
  // 第二个真人确认后结算层会在同一事件循环内卸载；DOM click 避免 Playwright
  // 在事件已经生效后仍等待已消失元素的 actionability 回执。
  await button.evaluate((element: HTMLButtonElement) => element.click())
}

test('结算页刷新客端：恢复当前结算且不误入终局，确认后进入下一手', async ({ browser }) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })))
  const [host, client] = await Promise.all(contexts.map((context) => context.newPage()))
  const pageErrors = [host, client].map(() => [] as string[])
  const consoleLogs = [host, client].map(() => [] as string[])
  ;[host, client].forEach((page, index) => {
    page.on('pageerror', (error) => pageErrors[index].push(error.message))
    page.on('console', (message) => {
      const text = message.text()
      if (/\[host\]|\[client\]|\[diag\]|快照|结算|settled|result|丢弃|非法|warn|error/i.test(text)) {
        consoleLogs[index].push(`${message.type()}: ${text}`)
      }
    })
  })

  try {
    const suffix = Date.now().toString(36).slice(-6)
    await enterRemoteLobby(host, `结算房主-${suffix}`, APP)
    await host.getByRole('button', { name: '创建房间' }).click()
    await host.locator('.game-settings button', { hasText: '玩法' }).click()
    await host.getByRole('button', { name: /莲花麻将/ }).click()
    await host.getByRole('button', { name: '确定' }).click()
    await host.getByRole('button', { name: '确认创建' }).click()
    await acceptDisclaimerIfShown(host)
    await host.locator('.room-code strong').waitFor({ timeout: 30_000 })
    const roomCode = (await host.locator('.room-code strong').innerText()).trim()

    await enterRemoteLobby(client, `结算客人-${suffix}`, APP_AUTO)
    await client.getByRole('button', { name: '加入房间' }).click()
    await client.getByPlaceholder('输入 6 位房间码').fill(roomCode)
    await client.getByRole('button', { name: '确认加入' }).click()
    await acceptDisclaimerIfShown(client)

    for (const page of [host, client]) {
      await page.getByRole('button', { name: '准备 / 取消准备' }).waitFor({ timeout: 40_000 })
      await page.getByRole('button', { name: '准备 / 取消准备' }).click()
    }
    const start = host.getByRole('button', { name: /开始对局/ })
    await expect(start).toBeEnabled({ timeout: 40_000 })
    await start.click()
    await expect.poll(() => client.locator('.hand-tile-slot').count(), { timeout: 120_000 }).toBeGreaterThanOrEqual(4)
    await installHostAutoPlayer(host)
    console.log(`[spec] ${roomCode} 已开局，等待首手结算`)

    // 用户口径：单手必须在 6 分钟内进入结算。
    await expect(host.locator('.round-settlement')).toBeVisible({ timeout: 360_000 })
    await expect(client.locator('.round-settlement')).toBeVisible({ timeout: 30_000 }).catch(async (error) => {
      const states = await Promise.all([host, client].map(async (page) => ({
        round: await page.locator('.round-info').innerText().catch(() => ''),
        settlement: await page.locator('.round-settlement').innerText().catch(() => ''),
        final: await page.locator('.final-backdrop').isVisible().catch(() => false),
        banners: await page.locator('.remote-banner').allInnerTexts().catch(() => [] as string[]),
        body: (await page.locator('body').innerText().catch(() => '')).slice(0, 500),
      })))
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n`
        + `states=${JSON.stringify(states)}\n`
        + `hostLogs=${JSON.stringify(consoleLogs[0].slice(-80))}\n`
        + `clientLogs=${JSON.stringify(consoleLogs[1].slice(-80))}`,
      )
    })
    const roundBeforeReload = (await client.locator('.round-info').innerText()).trim()
    const settlementBeforeReload = await client.locator('.round-settlement').innerText()
    expect(roundBeforeReload).toMatch(/东[1-4]局/)
    console.log(`[spec] ${roomCode} 双端进入 ${roundBeforeReload} 结算，刷新客端`)

    await client.reload({ waitUntil: 'domcontentloaded' })

    await expect(client.locator('.round-settlement')).toBeVisible({ timeout: 120_000 })
    await expect(client.locator('.final-backdrop')).toHaveCount(0)
    await expect(host.locator('.final-backdrop')).toHaveCount(0)
    const restoredRound = (await client.locator('.round-info').innerText()).trim()
    const restoredSettlement = await client.locator('.round-settlement').innerText()
    expect(restoredRound).toBe(roundBeforeReload)
    expect(restoredSettlement.match(/东[1-4]局/)?.[0]).toBe(settlementBeforeReload.match(/东[1-4]局/)?.[0])
    console.log(`[spec] ${roomCode} 客端恢复同一结算，双方确认`)

    await Promise.all([clickContinue(host), clickContinue(client)])
    await expect.poll(async () => (await client.locator('.round-info').innerText().catch(() => '')).trim(), {
      timeout: 180_000,
      message: '结算页重进后双方确认仍未进入下一手',
    }).not.toBe(roundBeforeReload)
    await expect.poll(() => client.locator('.hand-tile-slot').count(), { timeout: 120_000 }).toBeGreaterThanOrEqual(4)
    console.log(`[spec] ${roomCode} 已进入下一手`)
    await expect(client.locator('.final-backdrop')).toHaveCount(0)
    expect(pageErrors[0], '房主出现未捕获异常').toEqual([])
    expect(pageErrors[1], '重进客端出现未捕获异常').toEqual([])
    console.log(`[spec] 结算页刷新重进通过（房间 ${roomCode}，${roundBeforeReload} → 下一手）`)
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
