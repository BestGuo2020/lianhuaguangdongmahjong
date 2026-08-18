// 自托管信令 + 真实 WebRTC 的四端对局冒烟：不依赖内置 mock。
// 前置：signaling/server.py 已在 ws://127.0.0.1:8787 监听，前端 dev 已在 5173 跑起来。
// 覆盖：建房 → 3 端加入 → 全员准备 → 开局 → 承诺洗牌完成 → 发牌（此前曾卡在洗牌超时）。
import { expect, test, type Page } from '@playwright/test'

const SELF_HOST = 'ws://127.0.0.1:8787'
const APP = `http://127.0.0.1:5173/?selfHost=${SELF_HOST}`

test.describe.configure({ mode: 'serial' })
// 四端建房/加入/准备/开局 + 承诺洗牌 + 开局动画，整体耗时可能超过 Playwright 默认 30s。
test.setTimeout(120_000)

async function enterRemoteLobby(page: Page, nickname: string) {
  await page.goto(APP)
  await page.getByRole('radio', { name: /联机对战/ }).click()
  await page.getByPlaceholder('输入昵称').fill(nickname)
}

/** 首次建房/加房会弹「同意并继续」免责声明，点掉即真正执行动作。 */
async function acceptDisclaimerIfShown(page: Page) {
  const accept = page.getByRole('button', { name: '同意并继续' })
  try {
    await accept.waitFor({ state: 'visible', timeout: 2000 })
    await accept.click()
  } catch {
    // 已同意过（localStorage 有记录）则无弹窗
  }
}

test('四端经自托管信令开局并发牌（承诺洗牌完成）', async ({ browser }) => {
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })))
  const pages = await Promise.all(contexts.map((context) => context.newPage()))
  const pageErrors = pages.map(() => [] as string[])
  pages.forEach((page, index) => {
    page.on('pageerror', (error) => pageErrors[index].push(error.message))
  })

  try {
    // ── 房主建房 ──
    const host = pages[0]
    await enterRemoteLobby(host, '房主')
    await host.getByRole('button', { name: '创建房间' }).click()
    await host.getByRole('button', { name: '确认创建' }).click()
    await acceptDisclaimerIfShown(host)
    await host.locator('.room-code strong').waitFor({ timeout: 20000 })
    const roomCode = (await host.locator('.room-code strong').innerText()).trim()
    expect(roomCode).toMatch(/^[A-Z0-9]{6}$/)

    // ── 3 个客户端加入 ──
    for (let i = 1; i <= 3; i += 1) {
      const client = pages[i]
      await enterRemoteLobby(client, `玩家${i}`)
      await client.getByRole('button', { name: '加入房间' }).click()
      await client.getByPlaceholder('输入 6 位房间码').fill(roomCode)
      await client.getByRole('button', { name: '确认加入' }).click()
      await acceptDisclaimerIfShown(client)
    }

    // ── 等 4 个座位都出现（本端 ready 按钮出现 = 已入座）──
    for (const page of pages) {
      await page.getByRole('button', { name: '准备 / 取消准备' }).waitFor({ timeout: 25000 })
    }

    // ── 全员准备 ──
    for (const page of pages) {
      await page.getByRole('button', { name: '准备 / 取消准备' }).click()
    }

    // ── 房主开始对局 ──
    const start = host.getByRole('button', { name: /开始对局/ })
    await expect(start).toBeEnabled({ timeout: 20000 })
    await start.click()

    // ── 断言发牌完成：承诺洗牌成功 → 摸牌动画 → 出现手牌 ──
    // 若洗牌仍超时，这里会一直等不到手牌，测试失败并露出问题。
    await expect
      .poll(() => host.locator('.hand-tile-slot').count(), {
        timeout: 45000,
        message: 'opening deal should complete after committed shuffle (手牌未出现)',
      })
      .toBeGreaterThanOrEqual(4)

    // 房主不应有未捕获异常。
    expect(pageErrors[0]).toEqual([])
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
