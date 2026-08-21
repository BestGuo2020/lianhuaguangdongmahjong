// 真实线上手机客户端观测：账号 2 加入用户创建的房间，自动操作账号 2 客户端，
// 手机房主继续手动操作；记录客户端开场、牌山和最终结算状态。
import { readFileSync } from 'node:fs'
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

interface Account { email: string; password: string }
interface OnlineConfig { url: string; accounts: [Account, Account] }
interface ClientObservation {
  at: number
  round: string
  phase: string
  openingStage: string
  wallCount: number
  wallHeadDrawn: number
  seatCount: number
  occupiedSeats: number
  finalVisible: boolean
  settlementVisible: boolean
  loadingVisible: boolean
}

function readOnlineConfig(): OnlineConfig {
  const raw = readFileSync('tmp/online_test', 'utf8')
  const url = raw.match(/测试 url：([^\r\n]+)/)?.[1]?.trim()
  const accounts = [...raw.matchAll(/账号\d+：([^，\r\n]+)，密码：([^\r\n]+)/g)]
    .map((match) => ({ email: match[1].trim(), password: match[2].trim() }))
  if (!url || accounts.length < 2) throw new Error('tmp/online_test 缺少测试 URL 或两个账号')
  return { url, accounts: [accounts[0], accounts[1]] }
}

const ONLINE = readOnlineConfig()
const ACCOUNT_2 = ONLINE.accounts[1]
const ROOM_CODE = (process.env.ONLINE_PHONE_ROOM ?? '').trim().toUpperCase()
if (!/^[A-Z0-9]{6}$/.test(ROOM_CODE)) throw new Error('请设置 ONLINE_PHONE_ROOM 为 6 位房间号')
const PROXY_SERVERS = (process.env.ONLINE_PROXY_SERVERS ?? '')
  .split(',').map((server) => server.trim()).filter(Boolean)
const CLIENT_PROXY = PROXY_SERVERS[1] ?? PROXY_SERVERS[0]
const BROWSER_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=IntensiveWakeUpThrottling',
]

test.setTimeout(2_400_000)

async function selectOnlineMode(page: Page) {
  await page.getByText('联机对战', { exact: false }).first().click()
}

async function acceptDisclaimerIfShown(page: Page) {
  const accept = page.getByRole('button', { name: '同意并继续' })
  try {
    await accept.waitFor({ state: 'visible', timeout: 3000 })
    await accept.click()
  } catch {
    // 已同意过时不会弹窗。
  }
}

async function authenticate(context: BrowserContext, account: Account): Promise<Page> {
  const page = await context.newPage()
  await page.goto(ONLINE.url, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await selectOnlineMode(page)
  const lobbyReady = () => page.getByRole('button', { name: '加入房间', exact: true }).isVisible().catch(() => false)
  if (await lobbyReady()) return page

  for (let session = 1; session <= 4; session += 1) {
    const login = page.getByRole('button', { name: '登录', exact: true })
    await expect(login).toBeVisible({ timeout: 30_000 })
    await expect(login).toBeEnabled({ timeout: 30_000 })
    const popupPromise = context.waitForEvent('page', { timeout: 30_000 })
    await login.click()
    const popup = await popupPromise
    console.log(`[PHONE-CLIENT][AUTH] OAuth 会话 ${session} 已打开`)
    const deadline = Date.now() + 120_000
    let submitted = false
    let authorizeClicked = false
    let popupRetryClicked = false
    let popupLoginClicked = false
    while (Date.now() < deadline) {
      if (await lobbyReady()) {
        await popup.close().catch(() => {})
        return page
      }
      if (popup.isClosed()) {
        await page.waitForTimeout(1000)
        if (await lobbyReady()) return page
        break
      }
      const authorize = popup.getByRole('button', { name: '同意并进入游戏', exact: true })
      const email = popup.locator('input[name=email]')
      const retry = popup.getByRole('button', { name: '重试', exact: true })
      const goLogin = popup.getByRole('button', { name: '去登录', exact: true })
      if (!authorizeClicked && await authorize.isVisible().catch(() => false)) {
        await authorize.click()
        authorizeClicked = true
      } else if (await email.isVisible().catch(() => false) && !submitted) {
        await email.fill(account.email)
        await popup.locator('input[name=password]').fill(account.password)
        await popup.getByRole('button', { name: '登录', exact: true }).click()
        submitted = true
      } else if (!popupRetryClicked && await retry.isVisible().catch(() => false)) {
        await retry.click()
        popupRetryClicked = true
      } else if (!popupLoginClicked && await goLogin.isVisible().catch(() => false)) {
        await goLogin.click()
        popupLoginClicked = true
        submitted = false
      }
      await page.waitForTimeout(400)
    }
    await popup.close().catch(() => {})
    if (session < 4) await page.waitForTimeout(1000)
  }
  throw new Error('账号2 OAuth 登录未能进入加入房间大厅')
}

async function installClientAutoPlayer(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as { __phoneClientAuto?: number }
    if (state.__phoneClientAuto) return
    state.__phoneClientAuto = window.setInterval(() => {
      const actionBar = document.querySelector('.action-bar')
      const hu = actionBar?.querySelector<HTMLButtonElement>('.action.hu')
      if (hu) { hu.click(); return }
      const pass = actionBar?.querySelector<HTMLButtonElement>('.action.pass')
      if (pass) { pass.click(); return }
      const tile = document.querySelector<HTMLElement>('.hand-rack.playable .hand-tile-slot .mahjong-tile')
      tile?.click()
    }, 150)
  })
}

async function readClientObservation(page: Page): Promise<ClientObservation> {
  return page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>('.game-table-hud')
    const loading = document.querySelector<HTMLElement>('.table-loading')
    const visible = (element: HTMLElement | null) => Boolean(element && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden'
      && getComputedStyle(element).display !== 'none'
      && Number(getComputedStyle(element).opacity) > 0)
    return {
      at: Date.now(),
      round: document.querySelector('.round-info')?.textContent?.trim() ?? '',
      phase: hud?.dataset.phase ?? '',
      openingStage: hud?.dataset.openingStage ?? '',
      wallCount: Number(hud?.dataset.wallCount ?? -1),
      wallHeadDrawn: Number(hud?.dataset.wallHeadDrawn ?? -1),
      seatCount: Number(hud?.dataset.tableSeats?.split(',').filter(Boolean).length ?? 0),
      occupiedSeats: document.querySelectorAll('.room-seat.occupied').length,
      finalVisible: visible(document.querySelector<HTMLElement>('.final-backdrop')),
      settlementVisible: visible(document.querySelector<HTMLElement>('.round-settlement')),
      loadingVisible: visible(loading),
    }
  }).catch(() => ({
    at: Date.now(), round: '', phase: '', openingStage: '', wallCount: -1, wallHeadDrawn: -1,
    seatCount: 0, occupiedSeats: 0, finalVisible: false, settlementVisible: false, loadingVisible: false,
  }))
}

test('账号2加入用户房间并观测一局莲花麻将东风场', async ({}, testInfo) => {
  const browser = await chromium.launch({
    headless: true,
    args: BROWSER_ARGS,
    ...(CLIENT_PROXY ? { proxy: { server: CLIENT_PROXY } } : {}),
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  let page: Page | null = null
  const observations: ClientObservation[] = []
  const anomalies: string[] = []
  try {
    page = await authenticate(context, ACCOUNT_2)
    await page.getByPlaceholder('输入昵称').fill(`账号2客户端-${Date.now().toString(36).slice(-5)}`)
    await page.getByRole('button', { name: '加入房间', exact: true }).click()
    await page.getByPlaceholder('输入 6 位房间码').fill(ROOM_CODE)
    await page.getByRole('button', { name: '确认加入', exact: true }).click()
    await acceptDisclaimerIfShown(page)
    await expect(page.locator('.room-seat.occupied')).toHaveCount(2, { timeout: 120_000 })
    const ready = page.getByRole('button', { name: '准备 / 取消准备', exact: true })
    await ready.waitFor({ state: 'visible', timeout: 60_000 })
    const ownSeat = page.locator('.room-seat').filter({ hasText: /账号2客户端-/ }).first()
    const readyDeadline = Date.now() + 30_000
    let readyConfirmed = false
    while (Date.now() < readyDeadline) {
      await ready.click().catch(() => {})
      readyConfirmed = await ownSeat.getByText('已准备', { exact: true }).isVisible().catch(() => false)
      if (readyConfirmed) break
      await page.waitForTimeout(1500)
    }
    expect(readyConfirmed, `账号2 客户端未在房主 roster 中确认准备（房间 ${ROOM_CODE}）`).toBe(true)
    console.log(`[PHONE-CLIENT] 已加入并确认准备房间 ${ROOM_CODE}，等待房主开始。`)
    await installClientAutoPlayer(page)

    const deadline = Date.now() + 1_800_000
    let previous: ClientObservation | null = null
    let noActionSince = Date.now()
    while (Date.now() < deadline) {
      const state = await readClientObservation(page)
      const signature = JSON.stringify(state)
      if (!previous || JSON.stringify(previous) !== signature) {
        observations.push(state)
        previous = state
        noActionSince = Date.now()
      }
      if (state.finalVisible) break
      if (previous && state.round === previous.round && state.phase === previous.phase
        && state.phase !== 'opening' && state.phase !== 'dealing'
        && state.wallCount > previous.wallCount + 2) {
        anomalies.push(`client wallCount jump ${previous.wallCount} -> ${state.wallCount} at ${state.round}`)
      }
      if (previous && state.round === previous.round && state.wallHeadDrawn >= 0
        && previous.wallHeadDrawn >= 0 && state.wallHeadDrawn < previous.wallHeadDrawn
        && state.phase !== 'opening' && state.phase !== 'dealing') {
        anomalies.push(`client wallHeadDrawn regression ${previous.wallHeadDrawn} -> ${state.wallHeadDrawn} at ${state.round}`)
      }
      if (Date.now() - noActionSince >= 180_000) {
        anomalies.push(`client no observable state action for 180s at ${state.round || '(unknown)'}`)
        noActionSince = Date.now()
      }
      await page.waitForTimeout(1000)
    }
    const finalState = await readClientObservation(page)
    await testInfo.attach('phone-client-observation', {
      body: JSON.stringify({ roomCode: ROOM_CODE, finalState, observations, anomalies }, null, 2),
      contentType: 'application/json',
    })
    expect(finalState.finalVisible, `账号2客户端未在限定时间进入最终结算（房间 ${ROOM_CODE}）`).toBe(true)
    expect(anomalies, `账号2客户端观测到牌山异常：${anomalies.join('；')}`).toEqual([])
    console.log(`[PHONE-CLIENT] 一局东风场结束：${ROOM_CODE}`)
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})
