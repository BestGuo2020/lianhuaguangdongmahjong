// 血流联机节奏实测（用户验收场景）：
// 1）1真人+3AI：胡牌动画播完之前，服务端不得开放下一家窗口/暴露刚摸的牌（WS 帧级断言）。
// 2）2真人：局末结算出现「继续下一局 (N)」倒计时；一端确认后显示「等待其他玩家（x/y）」，
//    另一端不点击也会由 10s 倒计时自动回执，随后进入下一局（对齐经典联机 continue 流程）。
import { expect, test, type Page } from '@playwright/test'

type ProtocolMessage = Record<string, unknown> & { kind?: string }
interface TimedMessage { at: number; message: ProtocolMessage }
interface SnapFrame { at: number; view: Record<string, any> }

test.describe.configure({ mode: 'serial' })
test.setTimeout(900_000)

function collectTimedProtocol(page: Page) {
  const messages: TimedMessage[] = []
  const sentMessages: TimedMessage[] = []
  const receivedBuffers = new Map<unknown, string>()
  const sentBuffers = new Map<unknown, string>()
  const tryParse = (buffer: string): ProtocolMessage | null => {
    try { return JSON.parse(buffer) as ProtocolMessage } catch { return null }
  }
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      // 大快照可能跨 WS 帧分片：按连接累积缓冲，完整 JSON 才算一条消息。
      const buffered = (receivedBuffers.get(socket) ?? '') + payload.toString()
      const message = tryParse(buffered)
      if (message !== null && typeof message === 'object') {
        receivedBuffers.delete(socket)
        messages.push({ at: Date.now(), message })
      } else {
        receivedBuffers.set(socket, buffered)
      }
    })
    socket.on('framesent', ({ payload }) => {
      const buffered = (sentBuffers.get(socket) ?? '') + payload.toString()
      const message = tryParse(buffered)
      if (message !== null && typeof message === 'object') {
        sentBuffers.delete(socket)
        sentMessages.push({ at: Date.now(), message })
      } else {
        sentBuffers.set(socket, buffered)
      }
    })
  })
  return { messages, sentMessages }
}

async function prepareRemotePage(page: Page, nickname: string) {
  await page.addInitScript(() => {
    localStorage.setItem('lgm_disclaimer_agreed', '1')
    localStorage.removeItem('lgm_session')
    localStorage.removeItem('lgm_nickname')
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.locator('.mode-selector button').nth(1).click()
  await page.locator('.remote-field input').fill(nickname)
}

async function selectBloodFlowRule(page: Page) {
  await page.locator('.remote-create').click()
  await page.locator('.lobby-dialog .game-settings > button').nth(1).click()
  await page.locator('.rule-picker-options button').nth(2).click()
  await page.locator('.lobby-dialog .dialog-actions .primary').click()
  await page.locator('.lobby-dialog .dialog-actions .primary').click()
}

/** 真人驱动一步：胡 > 过 > 点最右侧手牌打出（非本家回合/锁手时点击是无害 no-op）。 */
async function drivePageOnce(page: Page) {
  const hu = page.locator('button.action.hu').first()
  if (await hu.isVisible().catch(() => false)) { await hu.click({ timeout: 2000 }).catch(() => {}); return }
  const pass = page.locator('button.action.pass').first()
  if (await pass.isVisible().catch(() => false)) { await pass.click({ timeout: 2000 }).catch(() => {}); return }
  const tiles = page.locator('.hand-tile-slot .mahjong-tile')
  const count = await tiles.count()
  if (count > 0) await tiles.nth(count - 1).click({ timeout: 2000, force: true }).catch(() => {})
}

function snapshotFrames(messages: TimedMessage[]): SnapFrame[] {
  return messages
    .filter(({ message }) => message.kind === 'bf_snapshot' && message.view)
    .map(({ at, message }) => ({ at, view: (message as { view: Record<string, any> }).view }))
}

/**
 * 胡牌闸门帧级检查：携带新胡牌批次的快照必须仍处于表现闸门（窗口隐藏、刚摸的牌隐藏），
 * 下一家窗口只能在胡牌演出停顿（最低档 3015+100+摸牌 450ms）之后才重新开放。
 * 局末胡（批次与 roundResult 同帧）由前端 presentationBusy 门控结算面板，不在此断言。
 */
function checkWinGating(snaps: SnapFrame[]) {
  const violations: string[] = []
  const gaps: number[] = []
  let seen = 0
  let settledWin = false
  for (let i = 0; i < snaps.length; i++) {
    const batches: unknown[] = snaps[i].view?.public?.batches ?? []
    const settled = Boolean(snaps[i].view?.public?.roundResult)
    if (batches.length <= seen) continue
    if (settled) {
      settledWin = true
    } else {
      if (snaps[i].view.window) violations.push(`胡牌批次帧(第${batches.length}批)同帧暴露了窗口`)
      if ((snaps[i].view.players ?? []).some((p: { drawnTileIndex: number }) => p.drawnTileIndex >= 0)) {
        violations.push(`胡牌批次帧(第${batches.length}批)同帧暴露了刚摸的牌`)
      }
      const reveal = snaps.slice(i + 1).find((s) => s.view?.window && !s.view?.public?.roundResult)
      if (reveal) gaps.push(reveal.at - snaps[i].at)
    }
    seen = batches.length
  }
  return { violations, gaps, winCount: seen, settledWin }
}

test('single human vs 3 AI: win animation completes before the next player acts', async ({ page }) => {
  const protocol = collectTimedProtocol(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await prepareRemotePage(page, '血流验收甲')
  await selectBloodFlowRule(page)
  await expect(page.locator('.room-panel')).toBeVisible({ timeout: 30_000 })
  // 1 真人 + 3 服务端代打 AI：准备后直接开始。
  await page.locator('.room-panel .secondary').click()
  await expect(page.locator('.room-start')).toBeEnabled({ timeout: 10_000 })
  await page.locator('.room-start').click()
  await expect(page.locator('.game-table-hud')).toBeVisible({ timeout: 30_000 })
  // 空位身份由服务端下发（PLAYER_SEED），不再是引擎占位名「玩家2/3/4」。
  await expect(page.locator('.player-info strong').filter({ hasText: '南粤阿乐' })).toHaveCount(1)
  await expect(page.locator('.player-info strong').filter({ hasText: '西关十三姨' })).toHaveCount(1)
  await expect(page.locator('.player-info strong').filter({ hasText: '东山少爷' })).toHaveCount(1)

  const deadline = Date.now() + 360_000
  let result = checkWinGating(snapshotFrames(protocol.messages))
  while (Date.now() < deadline) {
    if (result.violations.length > 0) break
    if (result.gaps.length >= 2) break
    if (result.settledWin && result.winCount > 0) break
    await drivePageOnce(page)
    await page.waitForTimeout(350)
    result = checkWinGating(snapshotFrames(protocol.messages))
  }

  expect(result.violations, `胡牌动画被下一家动作抢跑：${result.violations.join('；')}`).toEqual([])
  expect(result.winCount, '限时内未观察到任何胡牌批次').toBeGreaterThan(0)
  for (const gap of result.gaps) {
    // 最低档停顿 3015 + 交接 100 + 摸牌 450 = 3565ms；给网络/渲染留 900ms 余量。
    expect(gap, '胡牌演出未播完就开放了下家窗口').toBeGreaterThanOrEqual(2600)
    expect(gap, '胡牌演出停顿异常过长').toBeLessThan(15000)
  }
  expect(errors).toEqual([])

  // 倒计时回归：结算面板出现后，本机 10s 倒计时要走完才回执 continue。
  // 此前经典 useRemoteContinueCountdown 在血流下仍隐藏运行（面板不显示它却仍在计时），
  // 结算快照到达 10s 即静默回执 → 面板可见倒计时只走到 ~4 就进下一局。
  if (result.settledWin) {
    await expect(page.locator('.bf-settlement')).toBeVisible({ timeout: 60_000 })
    if (await page.locator('.bf-settlement .bf-primary').count() > 0) {
      const panelAt = Date.now()
      await expect.poll(
        () => protocol.sentMessages.filter(({ message }) => (message as { kind?: string }).kind === 'continue').length,
        { timeout: 30_000, message: '结算后未自动回执 continue' },
      ).toBeGreaterThan(0)
      const sent = protocol.sentMessages
        .find(({ message }) => (message as { kind?: string }).kind === 'continue')!
      expect(sent.at - panelAt, '结算倒计时未走完就进入下一局').toBeGreaterThanOrEqual(8_000)
    }
  }
})

test('two humans: settlement shows countdown and waits for both confirms', async ({ browser }) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  const errorsA: string[] = []
  const errorsB: string[] = []
  const crashLog: string[] = []
  pageA.on('pageerror', (error) => errorsA.push(error.message))
  pageB.on('pageerror', (error) => errorsB.push(error.message))
  // 崩溃取证：环境级浏览器/渲染器死亡时留下时间戳，避免与业务失败混淆。
  pageA.on('crash', () => crashLog.push(`pageA crash @${new Date().toISOString()}`))
  pageB.on('crash', () => crashLog.push(`pageB crash @${new Date().toISOString()}`))
  browser.on('disconnected', () => crashLog.push(`browser disconnected @${new Date().toISOString()}`))
  const protocolA = collectTimedProtocol(pageA)
  const protocolB = collectTimedProtocol(pageB)

  try {
    await prepareRemotePage(pageA, '血流验收甲')
    await selectBloodFlowRule(pageA)
    await expect(pageA.locator('.room-panel')).toBeVisible({ timeout: 30_000 })
    const roomId = await pageA.locator('.room-code strong').textContent()
    expect(roomId).toMatch(/^[A-Z2-9]{6}$/)

    await prepareRemotePage(pageB, '血流验收乙')
    await pageB.locator('.remote-join-btn').click()
    await pageB.locator('.join-dialog-field input').fill(roomId ?? '')
    await pageB.locator('.lobby-dialog .dialog-actions .primary').click()
    await expect(pageB.locator('.room-panel')).toBeVisible({ timeout: 30_000 })

    await pageA.locator('.room-panel .secondary').click()
    await pageB.locator('.room-panel .secondary').click()
    await expect.poll(
      async () => pageB.locator('.room-seat em').filter({ hasText: '已准备' }).count(),
      { timeout: 20_000 },
    ).toBe(2)
    await expect(pageA.locator('.room-start')).toBeEnabled({ timeout: 10_000 })
    await pageA.locator('.room-start').click()
    await expect(pageA.locator('.game-table-hud')).toBeVisible({ timeout: 30_000 })
    await expect(pageB.locator('.game-table-hud')).toBeVisible({ timeout: 30_000 })

    // 两端各自驱动到局末结算出现（剩余两席由服务端 AI 代打）。
    // 盲点驱动的「打最右侧手牌」会点在结算遮罩上（@click.self 关面板），所以除 `.bf-settlement`
    // 还要认「返回结算」重开按钮——它同样只在结算到达后出现。
    const driveUntilSettled = async (page: Page) => {
      const deadline = Date.now() + 600_000
      while (Date.now() < deadline) {
        const settled = await page.locator('.bf-settlement, .blood-flow-result-reopen')
          .first().isVisible().catch(() => false)
        if (settled) return true
        await drivePageOnce(page)
        await page.waitForTimeout(300)
      }
      return false
    }
    let settledA = false
    let settledB = false
    try {
      ;[settledA, settledB] = await Promise.all([driveUntilSettled(pageA), driveUntilSettled(pageB)])
    } catch (error) {
      // 页面/浏览器被环境级杀死时带上取证信息，finally 不再掩盖真实错误。
      throw new Error(`对局驱动中断（crashLog: ${crashLog.join('; ') || '无记录'}）: ${String(error)}`)
    }
    expect(settledA, 'A 端限时内未出现结算').toBe(true)
    expect(settledB, 'B 端限时内未出现结算').toBe(true)
    // 面板若被盲点驱动关掉，用「返回结算」重新打开后再验证倒计时。
    for (const page of [pageA, pageB]) {
      const reopen = page.locator('.blood-flow-result-reopen')
      if (await reopen.isVisible().catch(() => false)) await reopen.click()
    }

    // 倒计时提醒（参照经典联机）：继续按钮带 (N) 秒数。
    await expect(pageA.locator('.bf-settlement .bf-primary')).toContainText(/\(\d{1,2}\)/, { timeout: 5_000 })
    await expect(pageB.locator('.bf-settlement .bf-primary')).toContainText(/\(\d{1,2}\)/, { timeout: 5_000 })

    // A 确认 → 显示「已准备，等待其他玩家（1/2）」，且在 B 回执前不会开下一局。
    await pageA.locator('.bf-settlement .bf-primary').click()
    await expect(pageA.locator('.bf-ready-status')).toContainText('已准备，等待其他玩家（1/2）', { timeout: 10_000 })
    await pageA.waitForTimeout(2500)
    await expect(pageA.locator('.round-info')).toContainText('东1局')

    // B 不点击：10s 倒计时到 0 自动回执 continue（对齐经典 useRemoteContinueCountdown）。
    await expect.poll(
      () => protocolB.sentMessages.filter((m) => m.message.kind === 'continue').length,
      { timeout: 30_000, message: 'B 端倒计时未自动回执 continue' },
    ).toBeGreaterThan(0)

    // 双端进入东2局（局号在开局动画开始即更新）。
    await expect(pageA.locator('.round-info')).toContainText('东2局', { timeout: 60_000 })
    await expect(pageB.locator('.round-info')).toContainText('东2局', { timeout: 60_000 })

    expect(errorsA).toEqual([])
    expect(errorsB).toEqual([])
    // A 端也应收到过就绪计数广播（1/2 → 2/2 进度可见）。
    const continuations = protocolA.messages
      .map(({ message }) => (message as { continuation?: { readySeats: number[] } }).continuation)
      .filter((c): c is { readySeats: number[] } => Boolean(c))
    expect(continuations.some((c) => c.readySeats.length >= 1)).toBe(true)
  } finally {
    await contextA.close().catch(() => {})
    await contextB.close().catch(() => {})
    if (crashLog.length) console.log(`[crash-log] ${crashLog.join('; ')}`)
  }
})
