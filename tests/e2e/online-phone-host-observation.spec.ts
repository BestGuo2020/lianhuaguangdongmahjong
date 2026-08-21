// 真实线上人工手机客户端观测：账号 2 创建房间，手机加入后由手机玩家参与一局。
// 房主页只自动处理房主自己的回合和 AI 补位；手机端仍由用户手动操作。
import { readFileSync } from 'node:fs'
import { chromium, expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

interface Account { email: string; password: string }
interface OnlineConfig { url: string; accounts: [Account, Account] }
interface HostObservation {
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
const PROXY_SERVERS = (process.env.ONLINE_PROXY_SERVERS ?? '')
  .split(',').map((server) => server.trim()).filter(Boolean)
const HOST_PROXY = PROXY_SERVERS[1] ?? PROXY_SERVERS[0]
const BROWSER_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=IntensiveWakeUpThrottling',
]

test.describe.configure({ mode: 'serial' })
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
  const lobbyReady = () => page.getByRole('button', { name: '创建房间', exact: true }).isVisible().catch(() => false)
  if (await lobbyReady()) return page

  for (let session = 1; session <= 4; session += 1) {
    const login = page.getByRole('button', { name: '登录', exact: true })
    await expect(login).toBeVisible({ timeout: 30_000 })
    await expect(login).toBeEnabled({ timeout: 30_000 })
    const popupPromise = context.waitForEvent('page', { timeout: 30_000 })
    await login.click()
    const popup = await popupPromise
    console.log(`[PHONE][AUTH] OAuth 会话 ${session} 已打开`)
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
  throw new Error('账号2 OAuth 登录未能进入创建房间大厅')
}

async function installHostAutoPlayer(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as { __phoneHostAuto?: number }
    if (state.__phoneHostAuto) return
    state.__phoneHostAuto = window.setInterval(() => {
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

async function readHostObservation(page: Page): Promise<HostObservation> {
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

async function observeAfterAbnormality(
  page: Page,
  observations: HostObservation[],
  reason: string,
) {
  const startedAt = Date.now()
  let last = ''
  while (Date.now() - startedAt < 180_000) {
    const state = await readHostObservation(page)
    const signature = JSON.stringify(state)
    if (signature !== last) {
      last = signature
      observations.push(state)
    }
    await page.waitForTimeout(1000)
  }
  console.log(`[PHONE] 异常后观望 180 秒结束：${reason}；期间状态变化 ${observations.length} 次`)
}

test('账号2创建房间，手机加入并完成一局莲花麻将东风场', async ({}, testInfo) => {
  const browser = await chromium.launch({
    headless: true,
    args: BROWSER_ARGS,
    ...(HOST_PROXY ? { proxy: { server: HOST_PROXY } } : {}),
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  let page: Page | null = null
  const observations: HostObservation[] = []
  const anomalies: string[] = []
  try {
    page = await authenticate(context, ACCOUNT_2)
    await page.getByPlaceholder('输入昵称').fill(`手机观测房主-${Date.now().toString(36).slice(-5)}`)
    await page.getByRole('button', { name: '创建房间', exact: true }).click()
    await page.locator('.game-settings button', { hasText: '玩法' }).click()
    await page.getByRole('button', { name: /莲花麻将/ }).click()
    await page.getByRole('button', { name: '确定' }).click()
    await page.getByRole('button', { name: '确认创建' }).click()
    await acceptDisclaimerIfShown(page)
    await page.locator('.room-code strong').waitFor({ timeout: 60_000 })
    const roomCode = (await page.locator('.room-code strong').innerText()).trim()
    console.log(`[PHONE] 房间号：${roomCode}`)
    console.log('[PHONE] 请手机打开试玩页，选择联机对战，加入该房间并点击“准备 / 取消准备”。')

    const joinDeadline = Date.now() + 900_000
    while (Date.now() < joinDeadline) {
      const occupied = await page.locator('.room-seat.occupied').count()
      if (occupied >= 2) break
      await page.waitForTimeout(1000)
    }
    await expect(page.locator('.room-seat.occupied')).toHaveCount(2, { timeout: 1000 })
    console.log('[PHONE] 手机客户端已进入房间；等待双方准备。')
    await installHostAutoPlayer(page)
    const ready = page.getByRole('button', { name: '准备 / 取消准备', exact: true })
    if (await ready.isVisible().catch(() => false)) await ready.click()
    const start = page.getByRole('button', { name: /开始对局/ })
    await expect(start).toBeEnabled({ timeout: 900_000 })
    console.log('[PHONE] 双方已准备，开始东风场。')
    await start.click()

    const deadline = Date.now() + 1_800_000
    let previous: HostObservation | null = null
    let noActionSince = Date.now()
    while (Date.now() < deadline) {
      const state = await readHostObservation(page)
      const signature = JSON.stringify(state)
      if (!previous || JSON.stringify(previous) !== signature) {
        observations.push(state)
        previous = state
        noActionSince = Date.now()
      }
      if (state.finalVisible) break
      if (previous && state.round && previous.round === state.round
        && state.phase && previous.phase && state.phase !== previous.phase) {
        anomalies.push(`phase changed within ${state.round}: ${previous.phase} -> ${state.phase}`)
      }
      if (previous && state.round === previous.round && state.phase === previous.phase
        && state.phase !== 'opening' && state.phase !== 'dealing'
        && state.wallCount > previous.wallCount + 2) {
        anomalies.push(`wallCount jump ${previous.wallCount} -> ${state.wallCount} at ${state.round}`)
        await observeAfterAbnormality(page, observations, anomalies.at(-1) ?? 'wall jump')
      }
      if (Date.now() - noActionSince >= 180_000) {
        anomalies.push(`no observable host state action for 180s at ${state.round || '(unknown)'}`)
        await observeAfterAbnormality(page, observations, anomalies.at(-1) ?? 'no action')
        noActionSince = Date.now()
      }
      await page.waitForTimeout(1000)
    }
    const finalState = await readHostObservation(page)
    await testInfo.attach('phone-host-observation', {
      body: JSON.stringify({ roomCode, finalState, observations, anomalies }, null, 2),
      contentType: 'application/json',
    })
    expect(finalState.finalVisible, `手机观测房间 ${roomCode} 未在限定时间进入最终结算`).toBe(true)
    console.log(`[PHONE] 一局东风场结束：${roomCode}；异常数 ${anomalies.length}`)
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})
