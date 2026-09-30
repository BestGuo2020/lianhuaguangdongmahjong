import { existsSync } from 'node:fs'
import { expect, test } from '@playwright/test'

// 两个长期分支的联机层不同；此用例只覆盖 master 的 WebSocket 入口。
test.skip(existsSync('src/game/online/transport/vibeRoomTransport.ts'), 'WebSocket-only regression')
test.setTimeout(120_000)

for (const rulesetId of ['lotus-classic', 'lotus-blood-flow'] as const) {
  test(`${rulesetId}: 房主在终局一键开始下一场`, async ({ page }) => {
    let starts = 0
    await page.addInitScript((rule) => {
      localStorage.setItem('lgm_disclaimer_agreed', '1')
      localStorage.setItem('lgm_session', JSON.stringify({
        roomId: 'ROOM01', rejoinCode: 'AAAA-BBBB', nickname: '房主',
        playerId: 'guest-host', mode: 'east', rulesetId: rule,
      }))
      const players = Array.from({ length: 4 }, (_, seat) => ({
        name: seat === 0 ? '房主' : `玩家${seat + 1}`, avatar: '', score: 2000, seat,
        hand: [], concealedTileCount: 13, discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
      }))
      const result = {
        ruleVersion: 'lotus-blood-flow-v1', roundId: 'round-3', reason: 'wall-exhausted',
        openingScores: [2000, 2000, 2000, 2000], endingScores: [2000, 2000, 2000, 2000],
        winNet: [0, 0, 0, 0], kongNet: [0, 0, 0, 0], winCounts: [0, 0, 0, 0],
        ranks: [1, 1, 1, 1], ledger: [],
      }
      const finalMessage = rule === 'lotus-classic' ? {
        kind: 'state_snapshot', roomId: 'ROOM01', mode: 'east', rulesetId: rule,
        phase: 'finished', round: 4, dealer: 3, honba: 0, wallCount: 0, wall: [], headDrawn: 0,
        currentPlayer: -1, players, seat: 0, result: null, announcement: null,
        matchFinished: true, lastDiscard: null, winPresentation: null, winningPlayerIndex: -1,
        flipTile: null, flipStack: null, openingStack: null,
      } : {
        kind: 'bf_snapshot', round: 4, mode: 'east', dealer: 3, matchFinished: true,
        roundResult: result,
        view: {
          authorityEpoch: 'bf-ROOM01', roundId: 'round-3', version: 3, seat: 0,
          players, currentPlayer: 0, wallCount: 0, headDrawn: 136,
          flipTile: 'p9', jokers: ['red', 'green'], flipStack: 0, flipSeat: 0,
          wallBreakIndex: 2, window: null, ownActions: [], ownScore: null, waitingSeats: [],
          public: {
            ruleVersion: 'lotus-blood-flow-v1', roundId: 'round-3', status: 'settled',
            seats: Array.from({ length: 4 }, () => ({ winCount: 0, locked: false, firstWinSequence: null, recordIds: [] })),
            batches: [], roundResult: result,
          },
          actionEvents: [], lastDiscardAction: null, kongEvents: [],
        },
      }
      const nextMessage = structuredClone(finalMessage) as Record<string, any>
      nextMessage.matchFinished = false
      nextMessage.round = 1
      if (rule === 'lotus-classic') {
        nextMessage.phase = 'playing'
      } else {
        nextMessage.roundResult = null
        nextMessage.view.roundId = 'round-0'
        nextMessage.view.public.roundId = 'round-0'
        nextMessage.view.public.status = 'playing'
        nextMessage.view.public.roundResult = null
      }
      class MockWebSocket {
        readyState = 0
        onopen: (() => void) | null = null
        onmessage: ((event: { data: string }) => void) | null = null
        onclose: (() => void) | null = null
        onerror: (() => void) | null = null
        constructor(readonly url: string) {
          ;(window as Window & { __resumeMatch?: () => void }).__resumeMatch = () => {
            this.onmessage?.({ data: JSON.stringify(nextMessage) })
          }
          setTimeout(() => {
            this.readyState = 1
            this.onopen?.()
            this.onmessage?.({ data: JSON.stringify({
              kind: 'rejoin_ok', seat: 0, rejoin: true, roomId: 'ROOM01', mode: 'east',
              rulesetId: rule, nickname: '房主', rejoinCode: 'AAAA-BBBB',
            }) })
            this.onmessage?.({ data: JSON.stringify(finalMessage) })
          }, 0)
        }
        send() {}
        close() { this.readyState = 3; this.onclose?.() }
      }
      window.WebSocket = MockWebSocket as unknown as typeof WebSocket
    }, rulesetId)
    await page.route('**/api/login/session', (route) => route.fulfill({ json: {
      authenticated: true, account: { id: 'host', displayName: '房主', avatarUrl: null },
    } }))
    await page.route('**/api/rooms/meta', (route) => route.fulfill({ json: { active: 1, max: 4 } }))
    await page.route('**/api/rooms/ROOM01', (route) => route.fulfill({ json: {
      roomId: 'ROOM01', mode: 'east', rulesetId, capacity: 4, status: 'finished', creatorSeat: 0,
      seats: [{ seat: 0, nickname: '房主', ready: true, connected: true }, null, null, null],
      llmEnabled: false, effectiveLlmEnabled: false, llmAvailable: false,
    } }))
    await page.route('**/api/rooms/ROOM01/start', (route) => {
      starts += 1
      return route.fulfill({ json: { roomId: 'ROOM01', status: 'playing' } })
    })

    await page.goto('/', { waitUntil: 'commit' })
    await page.locator('.continue-session').click()
    await expect(page.getByRole('button', { name: '再来一场' })).toBeVisible({ timeout: 45_000 })
    await page.getByRole('button', { name: '再来一场' }).click()
    await expect.poll(() => starts).toBe(1)
    await page.evaluate(() => (window as Window & { __resumeMatch?: () => void }).__resumeMatch?.())
    await expect(page.locator('.game-table-hud')).toBeVisible({ timeout: 30_000 })
  })
}
