// 四端完整对局回归：东风场 东1局 → 东4局 → 最终排名（docs/vibehub-issues-and-status.md §7
// 「三家确认下一局」「结算→确认→下一局」的真实浏览器验证）。
//
// 打法驱动：
// - 客户端（seat 1-3）用 ?auto=1：收到回合请求 600ms 后自动响应（可胡自动胡，否则智能弃牌；
//   claim/抢杠胡自动过）。
// - 房主（seat 0）是本地 HumanController（headless 引擎等 viewer 响应，固定 12s 倒计时太慢），
//   由注入页面的自动打牌器驱动：轮到本家点手牌出牌；claim/抢杠提示可胡点胡、否则点过。
// - 每局结算后各端 10s 自动「继续」，三家确认后房主进入下一局承诺洗牌（自动完成）。
//
// 断言：四端发牌完成 → 轮次从东1局推进到东4局 → 四端都出现最终排名页（.final-backdrop），
// 全程无未捕获异常、无断线误报。
// 前置：signaling/server.py 已在 ws://127.0.0.1:8787 监听，前端 dev 已在 5173 跑起来。
import { expect, test, type Page } from '@playwright/test'

const SELF_HOST = 'ws://127.0.0.1:8787'
const APP = `http://127.0.0.1:5173/?selfHost=${SELF_HOST}`
const APP_AUTO = `${APP}&auto=1`

test.describe.configure({ mode: 'serial' })
// 完整东风场 4 局（莲花麻将）：headless 环境每手 5-13s，全程最多 ~60 分钟。
test.setTimeout(4_800_000)

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

/** 房主页面注入自动打牌器：回合点第一张手牌出牌；claim/抢杠可胡点胡、否则点过。 */
async function installHostAutoPlayer(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __hostAuto?: number; __hostBeat?: number; __hostClicks?: number }
    if (w.__hostAuto) return
    w.__hostBeat = 0
    w.__hostClicks = 0
    // 心跳：每 1s 自增，检测页面定时器是否被后台冻结。
    setInterval(() => { w.__hostBeat = (w.__hostBeat ?? 0) + 1 }, 1000)
    w.__hostAuto = window.setInterval(() => {
      // claim/抢杠提示：action-bar 有胡/过按钮 → 优先处理。
      const bar = document.querySelector('.action-bar')
      if (bar) {
        const hu = bar.querySelector<HTMLButtonElement>('.action.hu')
        if (hu) { hu.click(); return }
        const pass = bar.querySelector<HTMLButtonElement>('.action.pass')
        if (pass) { pass.click(); return }
      }
      // 本家回合：.hand-rack.playable 表示 isUserTurn（比 .turn-timer 精确，
      // 后者在 claim 提示时也显示）→ 点第一张手牌出牌（桌面端一次点击即出牌）。
      // 注意：click 必须派发在 MahjongTile 自身（或其内部）上——.hand-tile-slot 是
      // MahjongTile 的父元素，事件冒泡向上不会触发子组件的 @click。
      const rack = document.querySelector('.hand-rack.playable')
      if (rack) {
        const tiles = rack.querySelectorAll<HTMLElement>('.hand-tile-slot')
        if (tiles.length) {
          const tileEl = tiles[0].querySelector<HTMLElement>('.mahjong-tile') ?? tiles[0]
          tileEl.click()
          w.__hostClicks = (w.__hostClicks ?? 0) + 1
          return
        }
      }
    }, 150)
  })
}

/** 读取房主页面顶部轮次标签（.round-info：东风场 · 东X局）。 */
async function readRoundLabel(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('.round-info')?.textContent ?? '')
}

test('四端打完东风场东1局→东4局并进入最终排名', async ({ browser }) => {
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })))
  const pages = await Promise.all(contexts.map((context) => context.newPage()))
  const pageErrors = pages.map(() => [] as string[])
  const consoleLogs = pages.map(() => [] as string[])
  // 每页心跳（1s 自增）：检测 headless 后台定时器节流/冻结。
  for (const page of pages) {
    await page.addInitScript(() => {
      const w = window as unknown as { __beat?: number }
      w.__beat = 0
      setInterval(() => { w.__beat = (w.__beat ?? 0) + 1 }, 1000)
    })
  }
  pages.forEach((page, index) => {
    page.on('pageerror', (error) => pageErrors[index].push(error.message))
    page.on('console', (message) => {
      const text = message.text()
      if (/\[host\]|\[client\]|\[selfHost\]|\[diag\]|error|warn|丢弃|重进|洗牌|快照|continue|shuffle|AI 代打/i.test(text)) {
        consoleLogs[index].push(text)
      }
    })
  })

  try {
    // ── 房主建房（非 auto），选「莲花麻将」（翻精癞子，胡牌容易、收敛快）──
    const host = pages[0]
    await enterRemoteLobby(host, '房主', APP)
    await host.getByRole('button', { name: '创建房间' }).click()
    // 创建对话框 → 点「玩法」→ 选「莲花麻将」→ 确定
    await host.locator('.game-settings button', { hasText: '玩法' }).click()
    await host.getByRole('button', { name: /莲花麻将/ }).click()
    await host.getByRole('button', { name: '确定' }).click()
    await host.getByRole('button', { name: '确认创建' }).click()
    await acceptDisclaimerIfShown(host)
    await host.locator('.room-code strong').waitFor({ timeout: 30000 })
    const roomCode = (await host.locator('.room-code strong').innerText()).trim()
    expect(roomCode).toMatch(/^[A-Z0-9]{6}$/)

    // ── 3 个 auto 客户端加入 ──
    for (let i = 1; i <= 3; i += 1) {
      const client = pages[i]
      await enterRemoteLobby(client, `玩家${i}`, APP_AUTO)
      await client.getByRole('button', { name: '加入房间' }).click()
      await client.getByPlaceholder('输入 6 位房间码').fill(roomCode)
      await client.getByRole('button', { name: '确认加入' }).click()
      await acceptDisclaimerIfShown(client)
    }

    // ── 全员准备 → 房主开始对局 ──
    for (const page of pages) {
      await page.getByRole('button', { name: '准备 / 取消准备' }).waitFor({ timeout: 40000 })
    }
    for (const page of pages) {
      await page.getByRole('button', { name: '准备 / 取消准备' }).click()
    }
    const start = host.getByRole('button', { name: /开始对局/ })
    await expect(start).toBeEnabled({ timeout: 40000 })
    await start.click()

    // ── 四端发牌完成（东1局开始）──
    for (const page of pages) {
      await expect
        .poll(() => page.locator('.hand-tile-slot').count(), { timeout: 120000 })
        .toBeGreaterThanOrEqual(4)
    }
    // 开局动画结束后给房主装自动打牌器。
    await installHostAutoPlayer(host)

    // ── 轮次推进：东1局 → 东2局 → 东3局 → 东4局（每局约 3-11 分钟）──
    const observed: string[] = []
    // 完整 4 局（莲花麻将）：headless 每手 5-13s，4 局最多 ~45 分钟，窗口 60 分钟。
    const deadline = Date.now() + 3600000
    let lastLogAt = 0
    while (Date.now() < deadline) {
      const text = await readRoundLabel(host)
      for (const marker of ['东1局', '东2局', '东3局', '东4局']) {
        if (text.includes(marker) && !observed.includes(marker)) observed.push(marker)
      }
      // 已出现最终排名（东4局打完）或看到东4局后仍无最终排名时继续等。
      const finalVisible = await host.locator('.final-backdrop').count().catch(() => 0)
      if (observed.includes('东4局') && finalVisible > 0) break
      // 每 60s 打一条进度（诊断对局是否推进）；前 3 分钟每秒采集房主回合诊断。
      if (Date.now() - lastLogAt > 60000) {
        lastLogAt = Date.now()
        const progress = await host.evaluate(() => ({
          round: document.querySelector('.round-info')?.textContent ?? '',
          tiles: document.querySelectorAll('.hand-tile-slot').length,
          turnTimer: document.querySelector('.turn-timer')?.textContent ?? null,
          rackPlayable: Boolean(document.querySelector('.hand-rack.playable')),
          actionBar: Boolean(document.querySelector('.action-bar')),
          final: Boolean(document.querySelector('.final-backdrop')),
        }))
        console.log(`[spec] 进度 ${(Date.now() - deadline + 3600000) / 60000 | 0}min:`, JSON.stringify(progress))
        const beats = []
        for (let i = 0; i < pages.length; i += 1) {
          beats.push(await pages[i].evaluate(() => (window as unknown as { __beat?: number }).__beat ?? -1))
        }
        console.log(`[spec] 心跳(p0..p3)=${beats.join(',')}`)
        console.log(`[spec] 房主 host-turn 诊断尾部:\n${consoleLogs[0].filter((l) => l.includes('host turn watch') || l.includes('countdown expire') || l.includes('tile activation')).slice(-15).join('\n')}`)
      }
      await host.waitForTimeout(3000)
    }
    console.log(`[spec] 观察到轮次: ${observed.join(' → ') || '（无）'}`)
    if (observed.length < 4) {
      const dumps = []
      for (let i = 0; i < pages.length; i += 1) {
        const state = await pages[i].evaluate(() => ({
          round: document.querySelector('.round-info')?.textContent ?? '',
          tiles: document.querySelectorAll('.hand-tile-slot').length,
          turnTimer: Boolean(document.querySelector('.turn-timer')),
          actionBar: Boolean(document.querySelector('.action-bar')),
          final: Boolean(document.querySelector('.final-backdrop')),
          body: document.body?.innerText?.slice(0, 200) ?? '',
        }))
        dumps.push(`页面${i}: ${JSON.stringify(state)}`)
      }
      const shuffleDiag = consoleLogs[1].filter((l) => l.includes('shuffle')).slice(-10)
      const wallDiag = consoleLogs.flatMap((logs, i) => logs.filter((l) => l.includes('wall-regress')).map((l) => `p${i}: ${l}`)).slice(-10)
      throw new Error(
        `对局未推进（观察到: ${observed.join(' → ') || '无'}）\n${dumps.join('\n')}\n`
        + `牌山回跳诊断:\n${wallDiag.join('\n') || '（无）'}\n`
        + `客户端1 shuffle 诊断:\n${shuffleDiag.join('\n')}\n`
        + `房主 console 尾部:\n${consoleLogs[0].slice(-12).join('\n')}`,
      )
    }
    expect(observed, '轮次未从东1局推进到东4局').toEqual(['东1局', '东2局', '东3局', '东4局'])

    // ── 四端都进入最终排名页 ──
    for (let i = 0; i < pages.length; i += 1) {
      await expect
        .poll(() => pages[i].locator('.final-backdrop').count(), {
          timeout: 300000,
          message: `页面 ${i} 未出现最终排名页`,
        })
        .toBeGreaterThanOrEqual(1)
    }

    // ── 全程无未捕获异常、无断线误报 ──
    for (let i = 0; i < pages.length; i += 1) {
      expect(pageErrors[i], `页面 ${i} 出现未捕获异常`).toEqual([])
      const banner = await pages[i].locator('.remote-banner').allInnerTexts().catch(() => [] as string[])
      for (const text of banner) {
        expect(text).not.toMatch(/网络断开|连接中断|尝试重新加入/)
      }
    }
    console.log(`[spec] 完整东风场对局通过（房间 ${roomCode}）`)
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
