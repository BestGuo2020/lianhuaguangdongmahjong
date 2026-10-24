// 四端开局动画一致性回归（docs/vibehub-issues-and-status.md §6.1）：
// 房主能看到 start/dice/deal 动画、客户端只有「开牌」或无动画的问题。
// 断言：四端都出现过 .opening-overlay（对局开始提示层），且最终四端都拿到手牌；
// 任何一端都不应有未捕获异常。骰子为 3D 表现无 DOM，不单独断言。
// 前置：signaling/server.py 已在 ws://127.0.0.1:8787 监听，前端 dev 已在 5173 跑起来。
import { expect, test, type Page } from '@playwright/test'

const SELF_HOST = 'ws://127.0.0.1:8787'
const APP = `http://127.0.0.1:5173/?selfHost=${SELF_HOST}`

test.describe.configure({ mode: 'serial' })
// 四端建房/加入/准备/开局 + 逐端轮询开局提示层；headless 软件 WebGL 与后台
// 计时器节流会让动画明显变慢，整体耗时可能超过 2 分钟。
test.setTimeout(400_000)

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

test('四端都出现开局提示层并完成发牌', async ({ browser }) => {
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })))
  const pages = await Promise.all(contexts.map((context) => context.newPage()))
  const pageErrors = pages.map(() => [] as string[])
  const consoleLogs = pages.map(() => [] as string[])
  pages.forEach((page, index) => {
    page.on('pageerror', (error) => pageErrors[index].push(error.message))
    page.on('console', (message) => {
      const text = message.text()
      if (/\[host\]|\[client\]|\[diag\]|error|warn|丢弃|重进|洗牌|快照|rejoin|shuffle/i.test(text)) {
        consoleLogs[index].push(text)
      }
    })
  })

  // 高分辨率时间线：MutationObserver 记录 .opening-overlay 出现/消失与手牌首次出现。
  for (const page of pages) {
    await page.addInitScript(() => {
      const log: string[] = []
      ;(window as unknown as { __overlayLog: string[] }).__overlayLog = log
      const record = (name: string) => log.push(`${Date.now()} ${name}`)
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof Element) {
              if (node.matches?.('.opening-overlay')) record('overlay+')
              if (node.matches?.('.hand-tile-slot')) record('tile+')
            }
            if (node instanceof Element && node.querySelectorAll) {
              node.querySelectorAll('.opening-overlay').forEach(() => record('overlay+'))
              node.querySelectorAll('.hand-tile-slot').forEach(() => record('tile+'))
            }
          })
          mutation.removedNodes.forEach((node) => {
            if (node instanceof Element && node.matches?.('.opening-overlay')) record('overlay-')
            if (node instanceof Element && node.querySelectorAll) {
              node.querySelectorAll('.opening-overlay').forEach(() => record('overlay-'))
            }
          })
        }
      })
      ;(window as unknown as { __overlayObserver?: MutationObserver }).__overlayObserver = observer
      observer.observe(document.documentElement ?? document, { childList: true, subtree: true })
    })
  }

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

    // ── 全员准备 → 房主开始对局 ──
    for (const page of pages) {
      await page.getByRole('button', { name: '准备 / 取消准备' }).click()
    }
    const start = host.getByRole('button', { name: /开始对局/ })
    await expect(start).toBeEnabled({ timeout: 20000 })
    await start.click()

    // ── 断言：四端都出现过开局提示层（openingStage === 'start' 的 .opening-overlay）──
    // round_start 是瞬时消息，'start' 阶段持续 ~1.25s+；从点开始对局起每 100ms 轮询，
    // 直到该端手牌出现为止。若某端从未出现提示层（旧 bug：客户端只有开牌/无动画），
    // 这里的轮询会在手牌出现后立即失败并给出明确信息。
    const seenOpeningOverlay = pages.map(() => ({ seen: false, tiles: false }))
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      for (let i = 0; i < pages.length; i += 1) {
        if (!seenOpeningOverlay[i].seen) {
          seenOpeningOverlay[i].seen = (await pages[i].locator('.opening-overlay').count()) > 0
        }
        if (!seenOpeningOverlay[i].tiles) {
          seenOpeningOverlay[i].tiles = (await pages[i].locator('.hand-tile-slot').count()) >= 4
        }
      }
      if (seenOpeningOverlay.every((entry) => entry.seen && entry.tiles)) break
      await pages[0].waitForTimeout(100)
    }

    const problems: string[] = []
    for (let i = 0; i < pages.length; i += 1) {
      const entry = seenOpeningOverlay[i]
      if (!entry.seen || !entry.tiles) {
        const hud = (await pages[i].locator('.game-table-hud').count()) > 0
        const loading = await pages[i].locator('.table-loading').isVisible().catch(() => false)
        const timeline = await pages[i].evaluate(() => {
          const raw = (window as unknown as { __overlayLog?: string[] }).__overlayLog ?? []
          const start = raw.length ? Number(raw[0].split(' ')[0]) : Date.now()
          return raw.map((line) => {
            const [ts, ...rest] = line.split(' ')
            return `${(Number(ts) - start) / 1000}s ${rest.join(' ')}`
          })
        })
        const logs = consoleLogs[i].slice(-15).join('\n        ')
        problems.push(
          `页面 ${i}（${i === 0 ? '房主' : `玩家${i}`}）：openingOverlaySeen=${entry.seen} tiles=${entry.tiles}`
          + ` hud=${hud} loading=${loading}\n        时间线：${timeline.join(' | ') || '（无）'}\n        console：${logs}`,
        )
      }
    }
    if (problems.length > 0) throw new Error(`开局提示层断言失败：\n${problems.join('\n')}`)

    // ── 四端都不应有未捕获异常 ──
    for (let i = 0; i < pages.length; i += 1) {
      expect(pageErrors[i], `页面 ${i} 出现未捕获异常`).toEqual([])
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
