// 公网应用层边界：3 真人 + 1 AI，同时让一个客端在进入牌桌时处于慢速网络，
// 恢复正常速率后牌山/手牌仍须出现且保持，不得被 loading 或半初始化快照清空。
import { expect, test, type Page } from '@playwright/test'

const SIGNALING = 'wss://www.bestguo.top:58787'
const TURN = 'turn:turn:DZxaEm35GmecFZj@113.45.254.130:53478'
const APP = `http://127.0.0.1:5173/?selfHost=${SIGNALING}&turn=${TURN}`

test.describe.configure({ mode: 'serial' })
test.setTimeout(420_000)

async function enterRemoteLobby(page: Page, nickname: string) {
  await page.goto(APP)
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

async function readWallState(page: Page) {
  return page.evaluate(() => {
    const seen = new Set<number>()
    for (const element of document.querySelectorAll('*')) {
      const instance = (element as Element & { __vueParentComponent?: any }).__vueParentComponent
      if (!instance?.props || seen.has(instance.uid)) continue
      seen.add(instance.uid)
      const props = instance.props as Record<string, any>
      if (!('wallBreakIndex' in props) || !('wallCount' in props)) continue
      return {
        wallCount: Number(props.wallCount ?? 0),
        wallLength: Array.isArray(props.wall) ? props.wall.length : 0,
        wallHeadDrawn: Number(props.wallHeadDrawn ?? 0),
        wallBreakIndex: Number(props.wallBreakIndex ?? 0),
        openingStage: props.openingStage ?? null,
      }
    }
    return { wallCount: 0, wallLength: 0, wallHeadDrawn: 0, wallBreakIndex: 0, openingStage: null }
  })
}

test('3 真人 + 1 AI：慢速客端恢复网络后牌山和牌桌保持完整', async ({ browser }) => {
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })))
  const pages = await Promise.all(contexts.map((context) => context.newPage()))
  const pageErrors = pages.map(() => [] as string[])
  pages.forEach((page, index) => page.on('pageerror', (error) => pageErrors[index].push(error.message)))

  try {
    const [host, client1, slowClient] = pages
    const suffix = Date.now().toString(36).slice(-6)
    await enterRemoteLobby(host, `慢网房主-${suffix}`)
    await host.getByRole('button', { name: '创建房间' }).click()
    await host.locator('.game-settings button', { hasText: '玩法' }).click()
    await host.getByRole('button', { name: /莲花麻将/ }).click()
    await host.getByRole('button', { name: '确定' }).click()
    await host.getByRole('button', { name: '确认创建' }).click()
    await acceptDisclaimerIfShown(host)
    await host.locator('.room-code strong').waitFor({ timeout: 30_000 })
    const roomCode = (await host.locator('.room-code strong').innerText()).trim()

    for (const [index, client] of [client1, slowClient].entries()) {
      await enterRemoteLobby(client, `慢网客人${index + 1}-${suffix}`)
      await client.getByRole('button', { name: '加入房间' }).click()
      await client.getByPlaceholder('输入 6 位房间码').fill(roomCode)
      await client.getByRole('button', { name: '确认加入' }).click()
      await acceptDisclaimerIfShown(client)
    }

    for (const page of pages) {
      await page.getByRole('button', { name: '准备 / 取消准备' }).waitFor({ timeout: 40_000 })
    }
    await expect(host.locator('.room-seat')).toHaveCount(3)

    // 核心应用已加载；在牌桌动态资源、opening 快照和 3D 初始化开始前降速。
    const cdp = await contexts[2].newCDPSession(slowClient)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: 64 * 1024,
      uploadThroughput: 32 * 1024,
      connectionType: 'cellular3g',
    })

    for (const page of pages) await page.getByRole('button', { name: '准备 / 取消准备' }).click()
    const start = host.getByRole('button', { name: /开始对局/ })
    await expect(start).toBeEnabled({ timeout: 40_000 })
    await start.click()

    // 让慢速条件覆盖动态牌桌加载与初始快照窗口，再解除限速。
    await slowClient.waitForTimeout(8000)
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: 'none',
    })

    for (const page of pages) {
      await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 120_000 }).toBeGreaterThanOrEqual(4)
      await expect(page.locator('.player-seat')).toHaveCount(3)
    }
    await expect(slowClient.locator('.table-loading')).toBeHidden({ timeout: 30_000 })

    const restored = await readWallState(slowClient)
    expect(restored.wallCount, '解除限速后逻辑牌山为空').toBeGreaterThan(0)
    expect(restored.wallLength, '解除限速后传给 3D 牌桌的牌山为空').toBeGreaterThan(0)

    // 再观察 15 秒，防止恢复后被迟到的半初始化/旧快照清空或回跳。
    await slowClient.waitForTimeout(15_000)
    const stable = await readWallState(slowClient)
    expect(stable.wallCount, '恢复网络后牌山随后消失').toBeGreaterThan(0)
    expect(stable.wallLength, '恢复网络后 3D 牌山随后消失').toBeGreaterThan(0)
    expect(stable.wallHeadDrawn).toBeGreaterThanOrEqual(restored.wallHeadDrawn)
    expect(stable.wallCount).toBeLessThanOrEqual(restored.wallCount)
    for (let index = 0; index < pages.length; index += 1) {
      expect(pageErrors[index], `页面 ${index} 出现未捕获异常`).toEqual([])
    }
    console.log(`[spec] 3真人+1AI 慢网恢复通过（房间 ${roomCode}，wall ${restored.wallCount}→${stable.wallCount}）`)
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
