// 公网信令 + P2P→Relay 回归（docs/vibehub-issues-and-status.md §5）：
// 前置：前端 dev 已在 5173 跑起来；公网信令 wss://www.bestguo.top:58787 + TURN 113.45.254.130:53478 可达。
//
// 场景 A：加入后 25s 自动模拟一次 P2P → Relay 切换并保持（?selfHostRelayAfter），
//   断言切换后四端对局不中断、不误报断线横幅、无未捕获异常（hostId/座位/epoch 由
//   应用层快照门禁保证不变——见 useVibeRemoteGame/transport 单测）。
// 场景 B：?forceRelay=1 强制所有连接走 TURN 中继（真实 relay 路径），断言四端仍能开局并发牌。
import { expect, test, type Page } from '@playwright/test'

const SIGNALING = 'wss://www.bestguo.top:58787'
const TURN = 'turn:turn:DZxaEm35GmecFZj@113.45.254.130:53478'
// 云服务器 UDP 53478 已放行（2026-08-18 运维调整）；默认 turn: URL 走 UDP TURN。
const BASE = `http://127.0.0.1:5173/?selfHost=${SIGNALING}&turn=${TURN}`

test.describe.configure({ mode: 'serial' })
// 公网信令 + WebRTC/TURN 建连比本地慢，整体放宽。
test.setTimeout(420_000)

async function enterRemoteLobby(page: Page, nickname: string, app: string) {
  await page.goto(app)
  await page.getByRole('radio', { name: /联机对战/ }).click()
  await page.getByPlaceholder('输入昵称').fill(nickname)
}

/** 首次建房/加房会弹「同意并继续」免责声明，点掉即真正执行动作。 */
async function acceptDisclaimerIfShown(page: Page) {
  const accept = page.getByRole('button', { name: '同意并继续' })
  try {
    await accept.waitFor({ state: 'visible', timeout: 3000 })
    await accept.click()
  } catch {
    // 已同意过（localStorage 有记录）则无弹窗
  }
}

/** 建房 → 3 端加入 → 全员准备 → 开局 → 四端发牌完成。 */
async function startFourPlayerGame(browser: import('@playwright/test').Browser, app: string) {
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })))
  const pages = await Promise.all(contexts.map((context) => context.newPage()))
  const pageErrors = pages.map(() => [] as string[])
  pages.forEach((page, index) => {
    page.on('pageerror', (error) => pageErrors[index].push(error.message))
  })

  const host = pages[0]
  await enterRemoteLobby(host, '房主', app)
  await host.getByRole('button', { name: '创建房间' }).click()
  await host.getByRole('button', { name: '确认创建' }).click()
  await acceptDisclaimerIfShown(host)
  await host.locator('.room-code strong').waitFor({ timeout: 30000 })
  const roomCode = (await host.locator('.room-code strong').innerText()).trim()
  expect(roomCode).toMatch(/^[A-Z0-9]{6}$/)

  for (let i = 1; i <= 3; i += 1) {
    const client = pages[i]
    await enterRemoteLobby(client, `玩家${i}`, app)
    await client.getByRole('button', { name: '加入房间' }).click()
    await client.getByPlaceholder('输入 6 位房间码').fill(roomCode)
    await client.getByRole('button', { name: '确认加入' }).click()
    await acceptDisclaimerIfShown(client)
  }

  for (const page of pages) {
    await page.getByRole('button', { name: '准备 / 取消准备' }).waitFor({ timeout: 40000 })
  }
  for (const page of pages) {
    await page.getByRole('button', { name: '准备 / 取消准备' }).click()
  }
  const start = host.getByRole('button', { name: /开始对局/ })
  await expect(start).toBeEnabled({ timeout: 40000 })
  await start.click()

  for (const page of pages) {
    await expect
      .poll(() => page.locator('.hand-tile-slot').count(), { timeout: 120000 })
      .toBeGreaterThanOrEqual(4)
  }
  return { contexts, pages, pageErrors, roomCode }
}

test('公网信令四端开局 + 模拟 P2P→Relay 切换后对局不中断', async ({ browser }) => {
  // 25s 后注入 P2P→Relay 切换并保持（对局进行中），持续验证 15s。
  const app = `${BASE}&selfHostRelayAfter=25000&selfHostRelayDuration=0`
  const { contexts, pages, pageErrors, roomCode } = await startFourPlayerGame(browser, app)

  try {
    // 等切换发生后（join 后 25s + 余量），再观察 15s：对局应持续、无断线误报、无异常。
    await pages[0].waitForTimeout(15000)
    await pages[0].waitForTimeout(15000)

    for (let i = 0; i < pages.length; i += 1) {
      const tiles = await pages[i].locator('.hand-tile-slot').count()
      expect(tiles, `页面 ${i} 在 P2P→Relay 切换后手牌丢失`).toBeGreaterThanOrEqual(4)
      // relay 是可用保底路径：不能出现「网络断开/房主连接中断/尝试重新加入」横幅。
      const banner = await pages[i].locator('.remote-banner').allInnerTexts().catch(() => [] as string[])
      for (const text of banner) {
        expect(text, `页面 ${i} 在 relay 切换后误报断线：${text}`).not.toMatch(/网络断开|连接中断|尝试重新加入/)
      }
      expect(pageErrors[i], `页面 ${i} 出现未捕获异常`).toEqual([])
    }
    console.log(`[spec] relay-switch 场景A通过（房间 ${roomCode}）`)
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test('模拟 P2P→Relay→回 P2P 往返切换：对局全程不中断', async ({ browser }) => {
  // 20s 后注入 P2P→Relay，保持 20s 后回到 P2P；对局进行中经历两次路径切换。
  const app = `${BASE}&selfHostRelayAfter=20000&selfHostRelayDuration=20000`
  const { contexts, pages, pageErrors, roomCode } = await startFourPlayerGame(browser, app)

  try {
    // 等切换发生（20s）→ 回到 P2P（40s），再观察 15s。
    await pages[0].waitForTimeout(45000)
    await pages[0].waitForTimeout(15000)

    for (let i = 0; i < pages.length; i += 1) {
      const tiles = await pages[i].locator('.hand-tile-slot').count()
      expect(tiles, `页面 ${i} 在 P2P→Relay→回 P2P 切换后手牌丢失`).toBeGreaterThanOrEqual(4)
      const banner = await pages[i].locator('.remote-banner').allInnerTexts().catch(() => [] as string[])
      for (const text of banner) {
        expect(text, `页面 ${i} 在路径切换后误报断线：${text}`).not.toMatch(/网络断开|连接中断|尝试重新加入/)
      }
      expect(pageErrors[i], `页面 ${i} 出现未捕获异常`).toEqual([])
    }
    console.log(`[spec] relay-switch 场景C（往返切换）通过（房间 ${roomCode}）`)
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test('forceRelay：强制走 TURN 中继（默认 UDP），四端仍能开局并发牌', async ({ browser }) => {
  const app = `${BASE}&forceRelay=1`
  const { contexts, pages, pageErrors, roomCode } = await startFourPlayerGame(browser, app)

  try {
    // 全程 relay 直连已运行一段时间：再观察 10s 无异常。
    await pages[0].waitForTimeout(10000)
    for (let i = 0; i < pages.length; i += 1) {
      const tiles = await pages[i].locator('.hand-tile-slot').count()
      expect(tiles, `页面 ${i} 在 TURN relay 下手牌丢失`).toBeGreaterThanOrEqual(4)
      const banner = await pages[i].locator('.remote-banner').allInnerTexts().catch(() => [] as string[])
      for (const text of banner) {
        expect(text, `页面 ${i} 误报断线：${text}`).not.toMatch(/网络断开|连接中断|尝试重新加入/)
      }
      expect(pageErrors[i], `页面 ${i} 出现未捕获异常`).toEqual([])
    }
    console.log(`[spec] relay-switch 场景B（forceRelay/TURN）通过（房间 ${roomCode}）`)
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
