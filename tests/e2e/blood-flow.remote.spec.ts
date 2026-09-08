import { expect, test, type Page } from '@playwright/test'

type ProtocolMessage = Record<string, unknown> & { kind?: string }

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

function collectProtocolMessages(page: Page) {
  const messages: ProtocolMessage[] = []
  const sentMessages: ProtocolMessage[] = []
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
        messages.push(message)
      } else {
        receivedBuffers.set(socket, buffered)
      }
    })
    socket.on('framesent', ({ payload }) => {
      const buffered = (sentBuffers.get(socket) ?? '') + payload.toString()
      const message = tryParse(buffered)
      if (message !== null && typeof message === 'object') {
        sentBuffers.delete(socket)
        sentMessages.push(message)
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

test('two real clients run a blood-flow WS room through the released UI path', async ({ browser }) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  const errorsA: string[] = []
  const errorsB: string[] = []
  pageA.on('pageerror', (error) => errorsA.push(error.message))
  pageB.on('pageerror', (error) => errorsB.push(error.message))
  const protocolA = collectProtocolMessages(pageA)
  const protocolB = collectProtocolMessages(pageB)
  const { messages: messagesA, sentMessages: sentA } = protocolA
  const { messages: messagesB, sentMessages: sentB } = protocolB

  try {
    await prepareRemotePage(pageA, '血流甲')
    await selectBloodFlowRule(pageA)
    await expect(pageA.locator('.room-panel')).toBeVisible({ timeout: 30_000 })
    const roomId = await pageA.locator('.room-code strong').textContent()
    expect(roomId).toMatch(/^[A-Z2-9]{6}$/)

    await prepareRemotePage(pageB, '血流乙')
    await pageB.locator('.remote-join-btn').click()
    await pageB.locator('.join-dialog-field input').fill(roomId ?? '')
    await pageB.locator('.lobby-dialog .dialog-actions .primary').click()
    await expect(pageB.locator('.room-panel')).toBeVisible({ timeout: 30_000 })

    await pageA.locator('.room-panel .secondary').click()
    await pageB.locator('.room-panel .secondary').click()
    await expect.poll(
      async () => pageB.locator('.room-seat em').filter({ hasText: '已准备' }).count(),
      { timeout: 20_000, message: 'client B did not observe both ready seats' },
    ).toBe(2)
    await expect(pageA.locator('.room-start')).toBeEnabled({ timeout: 10_000 })
    await pageA.locator('.room-start').click()

    // 双方都收到权威 bf_snapshot，进入对局视图。
    // 双方应用真实消费了权威快照：血流牌桌 HUD 出现、手牌 ≥13 张（庄家 14）。
    await expect(pageA.locator('.game-table-hud')).toBeVisible({ timeout: 30_000 })
    await expect(pageB.locator('.game-table-hud')).toBeVisible({ timeout: 30_000 })
    // 联机开局动画：两端播完掷骰/翻精/发牌后回执 opening_done，服务端屏障才放行。
    await expect.poll(
      () => sentA.filter((m) => m.kind === 'opening_done').length,
      { timeout: 40_000, message: 'client A never acknowledged the opening animation' },
    ).toBeGreaterThan(0)
    await expect.poll(
      () => sentB.filter((m) => m.kind === 'opening_done').length,
      { timeout: 40_000, message: 'client B never acknowledged the opening animation' },
    ).toBeGreaterThan(0)
    await expect.poll(() => pageA.locator('.hand-tile-slot').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(13)
    await expect.poll(() => pageB.locator('.hand-tile-slot').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(13)
    await expect(pageA.locator('.base-score-badge')).toContainText('底分10')

    // 轮到庄家（A）时打出一张：动作经 WS 上行（action 帧小、可直接解析）。
    const tilesA = pageA.locator('.hand-tile-slot .mahjong-tile')
    await expect(tilesA.last()).toBeEnabled({ timeout: 60_000 })
    await tilesA.last().click()
    await expect.poll(
      () => sentA.filter((m) => m.kind === 'action').length,
      { timeout: 20_000, message: 'client A never sent an authoritative action' },
    ).toBeGreaterThan(0)

    // 局内过场：弃牌流水随快照下发（前端据此播弃牌音效、牌名播报与牌河高亮）。
    await expect.poll(
      () => messagesA.some((m) => m.kind === 'bf_snapshot'
        && (m.view as { lastDiscardAction?: unknown } | undefined)?.lastDiscardAction),
      { timeout: 20_000, message: 'client A never received a discard action' },
    ).toBe(true)

    // 服务器继续推进：B 的快照流持续到达（以 HUD 存续与无页面错误为准）。
    await expect(pageB.locator('.game-table-hud')).toBeVisible({ timeout: 20_000 })
    expect(errorsA).toEqual([])
    expect(errorsB).toEqual([])
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
