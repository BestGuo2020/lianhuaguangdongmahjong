import { expect, test, type Page } from '@playwright/test'

type ProtocolMessage = Record<string, unknown> & { kind?: string }

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

function collectProtocolMessages(page: Page) {
  const messages: ProtocolMessage[] = []
  const sentMessages: ProtocolMessage[] = []
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      const frame = payload.toString()
      try {
        const message = JSON.parse(frame) as ProtocolMessage
        if (message && typeof message === 'object') messages.push(message)
      } catch {
        // Ignore non-JSON frames such as transport pings.
      }
    })
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(payload.toString()) as ProtocolMessage
        if (message && typeof message === 'object') sentMessages.push(message)
      } catch {
        // Ignore non-JSON frames such as transport pings.
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

async function selectLegacyRule(page: Page) {
  await page.locator('.remote-create').click()
  await page.locator('.lobby-dialog .game-settings > button').nth(1).click()
  await page.locator('.rule-picker-options button').nth(1).click()
  await page.locator('.lobby-dialog .dialog-actions .primary').click()
  await page.locator('.lobby-dialog .dialog-actions .primary').click()
}

function latestSnapshot(messages: ProtocolMessage[]) {
  return [...messages]
    .reverse()
    .find((message) => message.kind === 'state_snapshot' && message.rulesetId === 'lotus-legacy')
}

function latestOpeningSnapshot(messages: ProtocolMessage[]) {
  return [...messages]
    .reverse()
    .find((message) => (
      message.kind === 'state_snapshot'
      && message.rulesetId === 'lotus-legacy'
      && message.phase === 'opening'
    ))
}

function ownOpeningHandCount(messages: ProtocolMessage[]) {
  const snapshot = latestOpeningSnapshot(messages)
  if (!snapshot || !Array.isArray(snapshot.players)) return 0
  const seat = snapshot.seat
  const player = snapshot.players.find((entry) => (
    entry && typeof entry === 'object' && entry.seat === seat
  )) as { hand?: unknown[] } | undefined
  return Array.isArray(player?.hand) ? player.hand.length : 0
}

test('runs a real two-client remote Lotus opening with matching authoritative state', async ({ browser }) => {
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
    await prepareRemotePage(pageA, '远端甲')
    await selectLegacyRule(pageA)
    await expect(pageA.locator('.room-panel')).toBeVisible({ timeout: 30_000 })
    const roomId = await pageA.locator('.room-code strong').textContent()
    expect(roomId).toMatch(/^[A-Z2-9]{6}$/)

    await prepareRemotePage(pageB, '远端乙')
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
    await expect.poll(
      async () => pageA.locator('.room-seat em').filter({ hasText: '已准备' }).count(),
      { timeout: 20_000, message: 'client A did not observe both ready seats' },
    ).toBe(2)
    await expect(pageA.locator('.room-start')).toBeEnabled({ timeout: 10_000 })
    await pageA.locator('.room-start').click()

    await expect.poll(
      () => messagesA.filter((message) => message.kind === 'round_start').length,
      { timeout: 20_000, message: 'client A did not receive round_start' },
    ).toBeGreaterThan(0)
    await expect.poll(
      () => messagesB.filter((message) => message.kind === 'round_start').length,
      { timeout: 20_000, message: 'client B did not receive round_start' },
    ).toBeGreaterThan(0)

    const startA = messagesA.find((message) => message.kind === 'round_start')
    const startB = messagesB.find((message) => message.kind === 'round_start')
    expect(startA).toMatchObject({
      secondDice: expect.any(Array),
      flipTile: expect.any(String),
      flipStack: expect.any(Number),
      flipSeat: expect.any(Number),
    })
    expect(startB).toMatchObject({
      dice: startA?.dice,
      secondDice: startA?.secondDice,
      flipTile: startA?.flipTile,
      flipStack: startA?.flipStack,
      flipSeat: startA?.flipSeat,
    })

    await expect(pageA.locator('.game-table-hud')).toBeVisible({ timeout: 20_000 })
    await expect(pageB.locator('.game-table-hud')).toBeVisible({ timeout: 20_000 })
    await expect(pageA.locator('.flip-indicator')).toBeVisible({ timeout: 30_000 })
    await expect(pageB.locator('.flip-indicator')).toBeVisible({ timeout: 30_000 })
    await expect.poll(
      () => sentA.filter((message) => message.type === 'opening_done').length,
      { timeout: 60_000, message: 'client A did not acknowledge opening completion' },
    ).toBeGreaterThan(0)
    await expect.poll(
      () => sentB.filter((message) => message.type === 'opening_done').length,
      { timeout: 60_000, message: 'client B did not acknowledge opening completion' },
    ).toBeGreaterThan(0)
    await expect.poll(
      () => ownOpeningHandCount(messagesA),
      { timeout: 10_000, message: 'client A opening snapshot has no complete hand' },
    ).toBeGreaterThanOrEqual(13)
    await expect.poll(
      () => ownOpeningHandCount(messagesB),
      { timeout: 10_000, message: 'client B opening snapshot has no complete hand' },
    ).toBeGreaterThanOrEqual(13)

    const flipLabelA = await pageA.locator('.flip-indicator .mahjong-tile').getAttribute('aria-label')
    const flipLabelB = await pageB.locator('.flip-indicator .mahjong-tile').getAttribute('aria-label')
    expect(flipLabelA).toBeTruthy()
    expect(flipLabelB).toBe(flipLabelA)

    await expect.poll(
      () => latestSnapshot(messagesA),
      { timeout: 10_000, message: 'client A did not receive an authoritative Lotus snapshot' },
    ).toBeTruthy()
    await expect.poll(
      () => latestSnapshot(messagesB),
      { timeout: 10_000, message: 'client B did not receive an authoritative Lotus snapshot' },
    ).toBeTruthy()
    const snapshotA = latestSnapshot(messagesA)
    const snapshotB = latestSnapshot(messagesB)
    const openingSnapshotA = latestOpeningSnapshot(messagesA)
    const openingSnapshotB = latestOpeningSnapshot(messagesB)
    expect(openingSnapshotA).toBeTruthy()
    expect(openingSnapshotB).toBeTruthy()
    expect(snapshotA).toMatchObject({
      rulesetId: 'lotus-legacy',
      wall: expect.any(Array),
      wallBreakIndex: expect.any(Number),
      openingStack: expect.any(Number),
      flipStack: startA?.flipStack,
      flipTile: startA?.flipTile,
    })
    expect(snapshotA?.wall).toHaveLength(snapshotB?.wall?.length as number)
    expect(snapshotB).toMatchObject({
      rulesetId: snapshotA?.rulesetId,
      wallBreakIndex: snapshotA?.wallBreakIndex,
      openingStack: snapshotA?.openingStack,
      flipStack: snapshotA?.flipStack,
      flipTile: snapshotA?.flipTile,
      jokerTiles: snapshotA?.jokerTiles,
      wildcardTiles: snapshotA?.wildcardTiles,
    })
    expect((snapshotA?.wall as unknown[]).every((tile) => tile === 'white')).toBe(true)
    expect((snapshotB?.wall as unknown[]).every((tile) => tile === 'white')).toBe(true)
    expect(errorsA).toEqual([])
    expect(errorsB).toEqual([])
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
