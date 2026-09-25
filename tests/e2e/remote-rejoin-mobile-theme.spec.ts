import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true })
test.setTimeout(120_000)

test('血流会话重进后切回单机，手机主题恢复原样', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('lgm_disclaimer_agreed', '1')
    localStorage.setItem('lgm_session', JSON.stringify({
      roomId: 'ROOM01', rejoinCode: 'AAAA-BBBB', nickname: '玩家',
      playerId: 'guest-1', mode: 'east', rulesetId: 'lotus-blood-flow',
    }))
    class MockWebSocket {
      readyState = 0
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(readonly url: string) {
        setTimeout(() => {
          this.readyState = 1
          this.onopen?.()
          this.onmessage?.({ data: JSON.stringify({
            kind: 'rejoin_ok', seat: 0, roomId: 'ROOM01', nickname: '玩家',
            rejoinCode: 'AAAA-BBBB', mode: 'east', rulesetId: 'lotus-blood-flow',
          }) })
        }, 0)
      }
      send() {}
      close() { this.readyState = 3; this.onclose?.() }
    }
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })
  await page.route('**/api/rooms/ROOM01', (route) => route.fulfill({
    json: {
      roomId: 'ROOM01', mode: 'east', rulesetId: 'lotus-blood-flow',
      capacity: 4, status: 'lobby', creatorSeat: 0,
      seats: [{ seat: 0, nickname: '玩家', ready: false, connected: true }, null, null, null],
      llmEnabled: true, effectiveLlmEnabled: true, llmAvailable: true,
    },
  }))
  await page.route('**/api/rooms/ROOM01/leave', (route) => route.fulfill({
    json: { roomId: 'ROOM01', seat: 0, left: true },
  }))

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'jade')
  await page.locator('.continue-session').click()
  await expect(page.locator('.room-panel')).toBeVisible()
  await expect(page.locator('.room-panel')).toContainText('血流')
  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'llm')

  await page.getByRole('button', { name: '离开房间' }).click()
  await page.getByRole('radio', { name: /单机对战/ }).click()
  await expect(page.locator('main.game-app')).toHaveAttribute('data-table-theme', 'jade')
  await expect(page.locator('.start-button')).toBeVisible()
})
