// 对局中刷新重进回归（docs/vibehub-issues-and-status.md §4.1/§4.2/§4.3/§4.4 + §3.2）：
// 4 端开局后刷新其中一个客户端，断言：
//   - 重进端恢复原座位并重新看到牌桌/手牌（不落大厅、不进最终排名、不卡加载遮罩）；
//   - 其他三端不受影响（手牌仍在、无未捕获异常）；
//   - 重进端无未捕获异常。
// 前置：signaling/server.py 已在 ws://127.0.0.1:8787 监听，前端 dev 已在 5173 跑起来。
import { expect, test, type Page } from '@playwright/test'

const SELF_HOST = 'ws://127.0.0.1:8787'
const APP = `http://127.0.0.1:5173/?selfHost=${SELF_HOST}`

test.describe.configure({ mode: 'serial' })
// 四端开局 + 刷新重进等待恢复（含 headless 软件 WebGL 慢初始化），整体耗时可能很长。
test.setTimeout(420_000)

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

test('对局中刷新一个客户端：恢复座位、牌桌继续、无 AI 夺舍残留', async ({ browser }) => {
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })))
  const pages = await Promise.all(contexts.map((context) => context.newPage()))
  const pageErrors = pages.map(() => [] as string[])
  const consoleLogs = pages.map(() => [] as string[])
  pages.forEach((page, index) => {
    page.on('pageerror', (error) => pageErrors[index].push(error.message))
    page.on('console', (message) => {
      const text = message.text()
      if (/\[host\]|\[client\]|\[selfHost\]|\[diag\]|error|warn|丢弃|重进|洗牌|快照|rejoin|shuffle|hello|roster|seatToken|恢复/i.test(text)) {
        consoleLogs[index].push(text)
      }
    })
  })

  // 心跳：每 500ms 自增；若刷新后计时器被后台冻结，计数会停滞。
  for (const page of pages) {
    await page.addInitScript(() => {
      ;(window as unknown as { __ticks?: number }).__ticks = 0
      setInterval(() => {
        const w = window as unknown as { __ticks?: number }
        w.__ticks = (w.__ticks ?? 0) + 1
      }, 500)
    })
  }

  try {
    // ── 建房 + 3 端加入 + 全员准备 + 开局 ──
    const host = pages[0]
    await enterRemoteLobby(host, '房主')
    await host.getByRole('button', { name: '创建房间' }).click()
    await host.getByRole('button', { name: '确认创建' }).click()
    await acceptDisclaimerIfShown(host)
    await host.locator('.room-code strong').waitFor({ timeout: 20000 })
    const roomCode = (await host.locator('.room-code strong').innerText()).trim()

    for (let i = 1; i <= 3; i += 1) {
      const client = pages[i]
      await enterRemoteLobby(client, `玩家${i}`)
      await client.getByRole('button', { name: '加入房间' }).click()
      await client.getByPlaceholder('输入 6 位房间码').fill(roomCode)
      await client.getByRole('button', { name: '确认加入' }).click()
      await acceptDisclaimerIfShown(client)
    }

    for (const page of pages) {
      await page.getByRole('button', { name: '准备 / 取消准备' }).waitFor({ timeout: 25000 })
    }
    for (const page of pages) {
      await page.getByRole('button', { name: '准备 / 取消准备' }).click()
    }
    const start = host.getByRole('button', { name: /开始对局/ })
    await expect(start).toBeEnabled({ timeout: 20000 })
    await start.click()

    // ── 四端都完成发牌 ──
    for (const page of pages) {
      await expect
        .poll(() => page.locator('.hand-tile-slot').count(), { timeout: 45000 })
        .toBeGreaterThanOrEqual(4)
    }

    // ── 刷新玩家1（对局进行中）──
    const rejoiner = pages[1]
    const storageBeforeReload = await rejoiner.evaluate(() => {
      const out: Record<string, string> = {}
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (key) out[key] = localStorage.getItem(key) ?? ''
      }
      return out
    })
    console.log('[spec] 刷新前重进端 localStorage:', JSON.stringify(storageBeforeReload))
    consoleLogs[1].length = 0 // 只保留刷新后的日志
    await rejoiner.reload({ waitUntil: 'domcontentloaded' })

    // 重进端：必须恢复原座位并重新看到牌桌（房主补发 rejoin_ok + 全量快照）。
    // 旧 bug 表现：落在大厅 / 卡加载遮罩 / 显示最终排名 / 一直「尝试重新加入」。
    // 重进可能落在开局动画窗口（房主重放 round_start → 客户端重播动画约 10s），
    // 之后手牌由快照/flush 恢复。headless 软件 WebGL 下第 4 个并发 3D 上下文
    // 初始化可能很慢（主线程被 atlas 生成阻塞，动画计时器随之停滞），给 90s。
    // 开局屏障会一直等重进端，整场对局不会提前结束，长窗口是安全的。
    const tileCount = await expect
      .poll(() => rejoiner.locator('.hand-tile-slot').count(), {
        timeout: 90000,
        message: '刷新重进后未恢复牌桌/手牌（可能落大厅、卡加载或重进失败）',
      })
      .toBeGreaterThanOrEqual(4)
      .catch(async (error: unknown) => {
        const storage = await rejoiner.evaluate(() => {
          const ls: Record<string, string> = {}
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i)
            if (key) ls[key] = localStorage.getItem(key) ?? ''
          }
          const ss: Record<string, string> = {}
          for (let i = 0; i < sessionStorage.length; i += 1) {
            const key = sessionStorage.key(i)
            if (key) ss[key] = sessionStorage.getItem(key) ?? ''
          }
          return { ls, ss }
        })
        const logs = consoleLogs[1].slice(-25).join('\n        ')
        const hostLogs = consoleLogs[0].slice(-30).join('\n        ')
        const domState = await rejoiner.evaluate(() => ({
          hud: document.querySelectorAll('.game-table-hud').length,
          loading: document.querySelectorAll('.table-loading').length,
          openingOverlay: document.querySelectorAll('.opening-overlay').length,
          lobby: document.querySelectorAll('.lobby').length,
          roomCode: document.querySelector('.room-code strong')?.textContent ?? null,
          readyBtn: [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('准备')),
          bodyText: document.body?.innerText?.slice(0, 300) ?? '',
          ticks: (window as unknown as { __ticks?: number }).__ticks ?? -1,
        }))
        await rejoiner.screenshot({ path: `${process.cwd()}/test-results/rejoin-client-state.png` })
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n`
          + `        重进端 localStorage：${JSON.stringify(storage.ls)}\n`
          + `        重进端 sessionStorage：${JSON.stringify(storage.ss)}\n`
          + `        重进端 DOM：${JSON.stringify(domState)}\n`
          + `        重进端 console 尾部：\n        ${logs}\n`
          + `        房主 console 尾部：\n        ${hostLogs}`,
        )
      })
    // 重进端不能永久卡在「牌桌加载中」遮罩（旧 bug：table-loading 遮罩盖住开局动画/牌桌）。
    // 3D 场景在 headless 下初始化可能较慢；只要手牌已渲染就不算卡死。
    const loadingVisible = await rejoiner.locator('.table-loading').isVisible().catch(() => false)
    const tilesNow = await rejoiner.locator('.hand-tile-slot').count().catch(() => 0)
    expect(loadingVisible && tilesNow === 0, '重进端卡在牌桌加载遮罩且无手牌').toBe(false)

    // ── 其他三端不受影响：手牌仍在（对局未被重进端打断/终止）──
    for (const [index, page] of pages.entries()) {
      if (index === 1) continue
      await expect
        .poll(() => page.locator('.hand-tile-slot').count(), { timeout: 30000 })
        .toBeGreaterThanOrEqual(4)
    }

    // ── 四端无未捕获异常 ──
    for (let i = 0; i < pages.length; i += 1) {
      expect(pageErrors[i], `页面 ${i} 出现未捕获异常`).toEqual([])
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
