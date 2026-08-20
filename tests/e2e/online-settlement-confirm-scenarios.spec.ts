// 结算确认三场景专项：东x局结束后「继续」确认的行为验证。
//
// 生产默认行为：结算页 10 秒倒计时自动确认（useRemoteContinueCountdown），
// manualContinue=1 关闭自动确认（严格真人确认屏障）。
//
// 场景 A：双方都不确认 → 应走生产默认 10 秒自动确认进入下一手。
//         必须证明是「自动确认倒计时」推进，而不是重进/恢复等异常路径：
//         ① 耗时符合「结算 → 10s 倒计时 → 切局」的合理窗口；
//         ② 两端控制台无恢复/重进日志；
//         ③ 下一手可能是连庄（东1·1本场），按手牌键变化判定而非固定东2局。
// 场景 B：仅房主确认、客户端不确认 → 严格屏障应阻止推进（房主结算层保持
//         「已确认，等待其他玩家…」）；客户端确认后才进入下一手。
// 场景 C：仅客户端确认、房主不确认 → 同样阻止推进（房主未确认，
//         hostReadyNext=false）；房主确认后才进入下一手。
//
// 凭据与 URL 只在运行时从 tmp/online_test 读取，绝不写入日志/附件。
import { readFileSync } from 'node:fs'
import { chromium, expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

interface Account { email: string; password: string }
interface OnlineConfig { url: string; accounts: [Account, Account] }
interface AutoPlayerEvent { at: number; type: 'hu-click' | 'pass-click' | 'discard-click' }
interface OpeningSample {
  at: number
  cycle: number
  hand: string
  stage: string | null
  diceValues: number[]
  diceThrowerIndex: number
  wallBreakIndex: number
  flipStack: number | null
  wallCount: number
  wallHeadDrawn: number
  dealSerial: number
  dealCount: number
}
interface WinPhaseSample {
  at: number
  hand: string
  phase: string
  wallCount: number
  wallHeadDrawn: number
  seats: number[]
  concealedCounts: number[]
  /** 仅记录每家收到的真实牌面张数，不保存任何具体牌值。 */
  revealedFaceCounts: number[]
  revealHands: boolean
  discardCounts: number[]
  meldTileCounts: number[]
  winEffectVisible: boolean
  settlementVisible: boolean
  confirmed: boolean
  tablePresent: boolean
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
test.setTimeout(30_000_000)

const ACCOUNT_BROWSER_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=IntensiveWakeUpThrottling',
]

// 可为两个真实账号分别注入浏览器级代理，例如：
// ONLINE_PROXY_SERVERS=http://proxy-a.example:3128,socks5://proxy-b.example:1080
// 未设置时保持生产默认直连；不在仓库里硬编码机器专属代理。
const ACCOUNT_PROXY_SERVERS = (process.env.ONLINE_PROXY_SERVERS ?? '')
  .split(',')
  .map((server) => server.trim())
  .filter(Boolean)

function accountProxy(index: number): { proxy?: { server: string } } {
  const server = ACCOUNT_PROXY_SERVERS[index] ?? ACCOUNT_PROXY_SERVERS[0]
  return server ? { proxy: { server } } : {}
}

interface AccountBrowserPair {
  browsers: [Browser, Browser]
  contexts: [BrowserContext, BrowserContext]
}

async function launchAccountBrowserPair(): Promise<AccountBrowserPair> {
  const browsers = await Promise.all(ONLINE.accounts.map((_, index) => chromium.launch({
    headless: true,
    args: ACCOUNT_BROWSER_ARGS,
    ...accountProxy(index),
  }))) as [Browser, Browser]
  try {
    const contexts = await Promise.all(browsers.map((browser) => browser.newContext({
      viewport: { width: 1280, height: 720 },
    }))) as [BrowserContext, BrowserContext]
    return { browsers, contexts }
  } catch (error) {
    await Promise.allSettled(browsers.map((browser) => browser.close()))
    throw error
  }
}

async function closeAccountBrowserPair(pair: AccountBrowserPair) {
  await Promise.allSettled(pair.browsers.map((browser) => browser.close()))
}

async function replaceAccountBrowser(pair: AccountBrowserPair, index: 0 | 1) {
  await pair.browsers[index].close().catch(() => {})
  const browser = await chromium.launch({
    headless: true,
    args: ACCOUNT_BROWSER_ARGS,
    ...accountProxy(index),
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  pair.browsers[index] = browser
  pair.contexts[index] = context
}

async function authenticateAccount(
  pair: AccountBrowserPair,
  index: 0 | 1,
  account: Account,
  manual: boolean,
): Promise<Page> {
  let lastError: unknown
  for (let processAttempt = 1; processAttempt <= 2; processAttempt += 1) {
    try {
      return await authenticate(pair.contexts[index], account, manual)
    } catch (error) {
      lastError = error
      if (processAttempt >= 2) break
      console.log(`[AUTH] 账号槽位 ${index + 1} 的 Chromium 进程授权耗尽，重建进程后进行最后一次尝试`)
      await replaceAccountBrowser(pair, index)
    }
  }
  throw lastError
}

async function selectOnlineMode(page: Page) {
  await page.getByText('联机对战', { exact: false }).first().click()
}

async function authenticate(context: BrowserContext, account: Account, manual: boolean) {
  const page = await context.newPage()
  const separator = ONLINE.url.includes('?') ? '&' : '?'
  const params = new URLSearchParams()
  // manualContinue=1 关闭生产默认的 10 秒自动确认；场景 A 不带该参数保留默认行为。
  if (manual) params.set('manualContinue', '1')
  for (let navigationAttempt = 1; navigationAttempt <= 3; navigationAttempt += 1) {
    try {
      await page.goto(`${ONLINE.url}${separator}${params}`, {
        waitUntil: 'domcontentloaded', timeout: 90_000,
      })
      break
    } catch (error) {
      if (navigationAttempt >= 3) throw error
      console.log(`[AUTH] 作品页导航第 ${navigationAttempt} 次失败，退避后重试`)
      await page.waitForTimeout(500 * navigationAttempt)
    }
  }
  await selectOnlineMode(page)
  if (await page.getByRole('button', { name: '创建房间', exact: true }).isVisible().catch(() => false)) {
    return page
  }

  const lobbyReady = () => page.getByRole('button', { name: '创建房间', exact: true })
    .isVisible().catch(() => false)
  const readGameAuthError = () => page.locator('.vibe-auth-error').innerText({ timeout: 500 })
    .then((text) => text.trim()).catch(() => '')
  const describePopup = async (popup: Page, stage: string) => {
    const rawUrl = popup.isClosed() ? '' : popup.url()
    let safeUrl = '(closed)'
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl)
        safeUrl = `${parsed.origin}${parsed.pathname}`
      } catch {
        safeUrl = '(unparseable)'
      }
    }
    const rawTitle = popup.isClosed() ? '' : await popup.title().catch(() => '')
    const safeTitle = rawTitle.replaceAll(account.email, '[redacted]').slice(0, 120) || '(empty)'
    return `stage=${stage} popup=${safeUrl} title=${JSON.stringify(safeTitle)}`
  }
  const openAuthPopup = async (session: number) => {
    const loginButton = page.getByRole('button', { name: '登录', exact: true })
    await expect(loginButton).toBeVisible({ timeout: 30_000 })
    await expect(loginButton).toBeEnabled({ timeout: 30_000 })
    const popupPromise = context.waitForEvent('page', { timeout: 30_000 })
    await loginButton.click()
    const popup = await popupPromise
    console.log(`[AUTH] OAuth 会话 ${session} 已打开`)
    return popup
  }
  const maxSessions = 4
  const stallMs = 25_000
  const deadline = Date.now() + 180_000
  let session = 1
  let popup = await openAuthPopup(session)
  let submitted = false
  let authorizeClicked = false
  let popupRetryClicked = false
  let popupLoginClicked = false
  let stage = 'opened'
  let progressSignature = ''
  let lastProgressAt = Date.now()
  let errorAtSessionStart = await readGameAuthError()
  while (Date.now() < deadline) {
    if (await lobbyReady()) {
      await popup.close().catch(() => {})
      console.log(`[AUTH] OAuth 会话 ${session} 已由游戏大厅确认成功`)
      return page
    }

    let restartReason = ''
    const gameAuthError = await readGameAuthError()
    if (gameAuthError && gameAuthError !== errorAtSessionStart) {
      restartReason = '游戏页报告登录失败'
    } else if (popup.isClosed()) {
      const callbackDeadline = Math.min(deadline, Date.now() + 15_000)
      let callbackError = ''
      while (Date.now() < callbackDeadline) {
        if (await lobbyReady()) {
          console.log(`[AUTH] OAuth 会话 ${session} 回调落地，游戏大厅确认成功`)
          return page
        }
        callbackError = await readGameAuthError()
        const loginButton = page.getByRole('button', { name: '登录', exact: true })
        if (callbackError && callbackError !== errorAtSessionStart
          && await loginButton.isVisible().catch(() => false)
          && await loginButton.isEnabled().catch(() => false)) break
        await page.waitForTimeout(250)
      }
      restartReason = callbackError && callbackError !== errorAtSessionStart
        ? '游戏页报告登录失败'
        : '弹窗关闭后 15 秒游戏大厅仍未就绪'
    } else {
      const authorize = popup.getByRole('button', { name: '同意并进入游戏', exact: true })
      const email = popup.locator('input[name=email]')
      const retryAuth = popup.getByRole('button', { name: '重试', exact: true })
      const goLogin = popup.getByRole('button', { name: '去登录', exact: true })
      if (!authorizeClicked && await authorize.isVisible().catch(() => false)) {
        await authorize.click()
        authorizeClicked = true
        stage = 'authorization-clicked'
        lastProgressAt = Date.now()
      } else if (await email.isVisible().catch(() => false)) {
        if (!submitted) {
          await email.fill(account.email)
          await popup.locator('input[name=password]').fill(account.password)
          await popup.getByRole('button', { name: '登录', exact: true }).click()
          submitted = true
          stage = 'credentials-submitted'
          lastProgressAt = Date.now()
        }
      } else if (!popupRetryClicked && await retryAuth.isVisible().catch(() => false)) {
        await retryAuth.click()
        popupRetryClicked = true
        stage = 'popup-retry-clicked'
        lastProgressAt = Date.now()
      } else if (!popupLoginClicked && await goLogin.isVisible().catch(() => false)) {
        await goLogin.click()
        popupLoginClicked = true
        submitted = false
        stage = 'popup-login-clicked'
        lastProgressAt = Date.now()
      }

      const signature = [popup.url(), await popup.title().catch(() => ''), stage].join('|')
      if (signature !== progressSignature) {
        progressSignature = signature
        lastProgressAt = Date.now()
      } else if (Date.now() - lastProgressAt >= stallMs) {
        restartReason = `弹窗 ${Math.round(stallMs / 1000)} 秒无进展`
      }
    }

    if (restartReason) {
      console.log(`[AUTH] OAuth 会话 ${session} 废弃：${restartReason}；${await describePopup(popup, stage)}`)
      await popup.close().catch(() => {})
      if (session >= maxSessions) break
      // 等上一轮 SDK 登录 Promise 因弹窗关闭而完成，再开始全新的 OAuth 会话。
      session += 1
      popup = await openAuthPopup(session)
      submitted = false
      authorizeClicked = false
      popupRetryClicked = false
      popupLoginClicked = false
      stage = 'opened'
      progressSignature = ''
      lastProgressAt = Date.now()
      errorAtSessionStart = await readGameAuthError()
      continue
    }
    await page.waitForTimeout(400)
  }
  const finalState = await describePopup(popup, stage)
  await popup.close().catch(() => {})
  throw new Error(`VibeHub 登录/授权在限定会话内未完成（sessions=${session} ${finalState}）`)
}

async function enterOnlineLobby(page: Page, nickname: string, role: 'host' | 'client') {
  const expected = page.getByRole('button', { name: role === 'host' ? '创建房间' : '加入房间', exact: true })
  if (!await expected.isVisible().catch(() => false)) await selectOnlineMode(page)
  await expect(expected).toBeVisible({ timeout: 30_000 })
  const input = page.getByPlaceholder('输入昵称')
  if (await input.isVisible().catch(() => false)) await input.fill(nickname)
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

async function waitForOpeningOrTableLoadError(page: Page, side: string) {
  const opening = page.locator('.opening-overlay')
  const finalLoadError = page.locator('.table-loading.has-error')
  await opening.or(finalLoadError).first().waitFor({ state: 'visible', timeout: 150_000 })
  if (await finalLoadError.isVisible().catch(() => false)) {
    const detail = await finalLoadError.innerText({ timeout: 1000 }).catch(() => '牌桌资源加载失败')
    throw new Error(`${side}牌桌资源自动重试耗尽：${detail.replace(/\s+/g, ' ').trim()}`)
  }
}

async function installHostAutoPlayer(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as {
      __onlineHostAuto?: number
      __onlineAutoPlayerEvents?: AutoPlayerEvent[]
    }
    if (state.__onlineHostAuto) return
    state.__onlineAutoPlayerEvents = []
    state.__onlineHostAuto = window.setInterval(() => {
      const actionBar = document.querySelector('.action-bar')
      if (actionBar) {
        const hu = actionBar.querySelector<HTMLButtonElement>('.action.hu')
        if (hu) {
          state.__onlineAutoPlayerEvents?.push({ at: Date.now(), type: 'hu-click' })
          hu.click()
          return
        }
        const pass = actionBar.querySelector<HTMLButtonElement>('.action.pass')
        if (pass) {
          state.__onlineAutoPlayerEvents?.push({ at: Date.now(), type: 'pass-click' })
          pass.click()
          return
        }
      }
      const tile = document.querySelector<HTMLElement>('.hand-rack.playable .hand-tile-slot .mahjong-tile')
      if (tile) {
        state.__onlineAutoPlayerEvents?.push({ at: Date.now(), type: 'discard-click' })
        tile.click()
      }
    }, 120)
  })
}

async function readRoundLabel(page: Page) {
  return page.locator('.round-info').innerText({ timeout: 1000 }).catch(() => '')
}

async function settlementVisible(page: Page) {
  const visible = await page.locator('.round-settlement').isVisible().catch(() => false)
  if (visible) return true
  return page.locator('.round-settlement .result-actions button').filter({ hasText: /^继续/ })
    .isVisible().catch(() => false)
}

/** 完整手牌键（局号 + 本场）：连庄后 round 不变、honba 递增，文本变化即可判定进入下一手。 */
function handKey(label: string): string {
  const round = label.match(/东[1-4]局/)?.[0] ?? ''
  const honba = label.match(/(\d+)本场/)?.[1] ?? '0'
  return round ? `${round}:${honba}` : ''
}

async function clickContinue(page: Page): Promise<boolean> {
  const button = page.locator('.round-settlement .result-actions button').filter({ hasText: /^继续/ }).first()
  if (!await button.isVisible().catch(() => false)) return false
  if (!await button.isEnabled().catch(() => false)) return false
  await button.evaluate((element: HTMLButtonElement) => element.click()).catch(() => {})
  return true
}

async function waitForHand(page: Page, expectedKey: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const label = await readRoundLabel(page)
    if (handKey(label) === expectedKey) return label
    await page.waitForTimeout(500)
  }
  return await readRoundLabel(page)
}

/** 等待「当前结算手牌键」在两端都出现结算弹窗。 */
async function waitForSettlement(host: Page, client: Page, expectedKey: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hostVisible = await settlementVisible(host)
    const clientVisible = await settlementVisible(client)
    if (hostVisible && clientVisible) {
      const hostLabel = await readRoundLabel(host)
      const clientLabel = await readRoundLabel(client)
      if (handKey(hostLabel) === expectedKey && handKey(clientLabel) === expectedKey) return
    }
    await host.waitForTimeout(500)
  }
  const hostLabel = await readRoundLabel(host)
  const clientLabel = await readRoundLabel(client)
  throw new Error(`等待 ${expectedKey} 双端结算弹窗超时（host=${hostLabel} client=${clientLabel}）`)
}

async function settlementIsDraw(page: Page): Promise<boolean> {
  const text = await page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => '')
  return /流局/.test(text)
}

/** 流局不计入胡牌专项；双端确认流局后继续推进，直到出现真实胡牌结算。 */
async function waitForWinningSettlement(
  host: Page,
  client: Page,
  initialKey: string,
  manualContinue: boolean,
): Promise<string> {
  let currentKey = initialKey
  for (let handIndex = 0; handIndex < 12; handIndex += 1) {
    await waitForSettlement(host, client, currentKey, 420_000)
    const draws = await Promise.all([host, client].map(settlementIsDraw))
    expect(draws[1], `${currentKey} 双端流局/胡牌结果必须一致`).toBe(draws[0])
    if (!draws[0]) return currentKey

    console.log(`[确认专项] ${currentKey} 为流局，继续推进到真实胡牌后再验证确认模式`)
    if (manualContinue) {
      expect(await clickContinue(host), `${currentKey} 流局后房主应能继续`).toBe(true)
      expect(await clickContinue(client), `${currentKey} 流局后客户端应能继续`).toBe(true)
    }
    const next = await waitForNextHand(host, client, currentKey, 180_000)
    currentKey = handKey(next.hostLabel)
    expect(currentKey, `流局后应进入有效下一手（${next.hostLabel} | ${next.clientLabel}）`).not.toBe('')
    expect(handKey(next.clientLabel), '流局后双端下一手必须一致').toBe(currentKey)
  }
  throw new Error('连续 12 手仍未出现真实胡牌，无法执行胡牌阶段确认专项')
}

/** 等待下一手（handKey 变化）出现：用于自动确认/补点确认后的推进判定。 */
async function waitForNextHand(host: Page, client: Page, currentKey: string, timeoutMs: number) {
  const pages: [Page, Page] = [host, client]
  try {
    const handles = await Promise.all(pages.map((page) => page.waitForFunction((oldKey) => {
      const label = document.querySelector('.round-info')?.textContent?.trim() ?? ''
      const round = label.match(/东[1-4]局/)?.[0] ?? ''
      const honba = label.match(/(\d+)本场/)?.[1] ?? '0'
      const key = round ? `${round}:${honba}` : ''
      return Boolean(key && key !== oldKey)
    }, currentKey, { timeout: timeoutMs, polling: 100 })))
    await Promise.all(handles.map((handle) => handle.dispose()))
  } catch {
    const labels = await Promise.all(pages.map(readRoundLabel))
    throw new Error(`等待离开 ${currentKey} 超时（host=${labels[0] || '(空)'} client=${labels[1] || '(空)'}）`)
  }
  const [hostLabel, clientLabel] = await Promise.all(pages.map(readRoundLabel))
  return { hostLabel, clientLabel }
}

/** 正常路径必须一次加入即同步双端 UI roster；禁止离开重入掩盖。 */
async function waitForRoomReady(host: Page, client: Page, roomCode: string) {
  const pages: [Page, Page] = [host, client]
  try {
    const handles = await Promise.all(pages.map((page) => page.waitForFunction(() => {
      const ready = [...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => (
        button.textContent?.trim() === '准备 / 取消准备'
          && button.getClientRects().length > 0
          && getComputedStyle(button).visibility !== 'hidden'
          && getComputedStyle(button).display !== 'none'
      ))
      return ready && document.querySelectorAll('.room-seat').length >= 2
    }, undefined, { timeout: 60_000, polling: 100 })))
    await Promise.all(handles.map((handle) => handle.dispose()))
    return
  } catch {
    // 下面读取原子页面状态用于失败诊断。
  }
  const states = await Promise.all(pages.map((page) => page.evaluate(() => ({
    ready: [...document.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.textContent?.trim() === '准备 / 取消准备'),
    seats: document.querySelectorAll('.room-seat').length,
  })).catch(() => ({ ready: false, seats: 0 }))))
  throw new Error(`正常加入后 60 秒 roster 仍未同步（room=${roomCode} states=${JSON.stringify(states)}）；禁止离开重入兜底`)
}

/** 建房 → 双端入房 → 开局 → 自动打牌直到指定局结算。返回 roomCode。 */
async function startEastHandToSettlement(
  host: Page,
  client: Page,
  suffix: string,
  manualContinue: boolean,
): Promise<{ roomCode: string; winningKey: string }> {
  await enterOnlineLobby(host, `确认专项房主-${suffix}`, 'host')
  await host.getByRole('button', { name: '创建房间', exact: true }).click()
  await host.locator('.game-settings button', { hasText: '玩法' }).click()
  await host.getByRole('button', { name: /莲花麻将/ }).click()
  await host.getByRole('button', { name: '确定' }).click()
  await host.getByRole('button', { name: '确认创建' }).click()
  await acceptDisclaimerIfShown(host)

  await host.locator('.room-code strong').waitFor({ timeout: 60_000 })
  const createdRoomCode = (await host.locator('.room-code strong').innerText()).trim()
  await enterOnlineLobby(client, `确认专项客人-${suffix}`, 'client')
  await client.getByRole('button', { name: '加入房间', exact: true }).click()
  await client.getByPlaceholder('输入 6 位房间码').fill(createdRoomCode)
  await client.getByRole('button', { name: '确认加入' }).click()
  await acceptDisclaimerIfShown(client)

  await host.locator('.room-code strong').waitFor({ timeout: 60_000 })
  const roomCode = (await host.locator('.room-code strong').innerText()).trim()
  expect(roomCode).toMatch(/^[A-Z0-9]{6}$/)
  await waitForRoomReady(host, client, roomCode)
  await Promise.all([host, client].map(installHostAutoPlayer))
  // 开局前安装时序采样器：记录每局 136/断点0 → 一骰 → 翻精134 → 二骰 → 断点 → 发牌。
  await Promise.all([host, client].map(installOpeningSampler))
  // 开局前即开始记录，确保保留胡牌前最后一个稳定牌桌状态。
  await Promise.all([host, client].map(installWinPhaseSampler))
  const start = host.getByRole('button', { name: /开始对局/ })
  if (!await start.isEnabled().catch(() => false)) {
    await host.getByRole('button', { name: '准备 / 取消准备' }).click()
    await client.getByRole('button', { name: '准备 / 取消准备' }).click()
  }
  await expect(start).toBeEnabled({ timeout: 60_000 })
  const openingPromises = [
    waitForOpeningOrTableLoadError(host, '房主'),
    waitForOpeningOrTableLoadError(client, '客户端'),
  ]
  await start.click()
  await Promise.all(openingPromises)

  // 等开局完成进入东1局，随后自动打牌直到指定局结算。
  const handLabel = await waitForHand(host, '东1局:0', 120_000)
  expect(handLabel).toContain('东1局')
  console.log(`[确认专项] 房间 ${roomCode} 已进入 ${handLabel}，等待真实胡牌结算`)
  const winningKey = await waitForWinningSettlement(host, client, '东1局:0', manualContinue)
  console.log(`[确认专项] 房间 ${roomCode} ${winningKey} 双端胡牌结算弹窗已出现`)
  return { roomCode, winningKey }
}

/** 收集页面控制台关键日志（不记录凭据/牌面）。 */
function attachConsoleCapture(page: Page, logs: string[]) {
  page.on('console', (message) => {
    const line = message.text()
    if (/\[host\]|\[client\]|\[diag\]|\[transport\]|重进|恢复|静默|round_start|opening|reconciler|continue|shuffle|error|warn/i.test(line)) {
      logs.push(line)
    }
  })
}

// 结算确认专项不能借助断线恢复、Relay 重建、AI 接管或重进补发推进。
// 只检查进入结算后的新增日志，避免把房间首次建连时的 rejoin_ok 握手误判为恢复。
const RECOVERY_PATH_PATTERN = /rejoin_ok|reconnecting|已验证重进|大厅验证的新 peer 已恢复|已重连|恢复牌局|先释放旧连接再重进|对局权威连续静默|单次请求当前手牌事实|升级为完整房间重进|自动重进失败|尝试重新加入房间|房主长时间无响应|AI 代打|AI 接管|relay.*active/i

function recoveryLogsSince(logs: string[], from: number): string[] {
  return logs.slice(from).filter((line) => RECOVERY_PATH_PATTERN.test(line))
}

/**
 * 胡牌阶段牌桌采样器：只记录数量和座位，不读取或保存具体暗牌牌值。
 * 从开局前持续采样到切局，MutationObserver 捕获 DOM 切换，20ms 定时器捕获
 * Vue 状态在 DOM 未变化时的短暂清空。
 */
async function installWinPhaseSampler(page: Page) {
  await page.evaluate(() => {
    const target = window as unknown as {
      __onlineWinPhaseSamples?: WinPhaseSample[]
      __onlineWinPhaseSampler?: number
      __onlineWinPhaseObserver?: MutationObserver
    }
    if (target.__onlineWinPhaseSampler) window.clearInterval(target.__onlineWinPhaseSampler)
    target.__onlineWinPhaseObserver?.disconnect()
    target.__onlineWinPhaseSamples = []
    let previous = ''
    let previousAt = 0
    const visible = (element: HTMLElement | null) => Boolean(element
      && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden'
      && getComputedStyle(element).display !== 'none'
      && Number(getComputedStyle(element).opacity) > 0)
    const sample = () => {
      const hud = document.querySelector<HTMLElement>('.game-table-hud')
      const canvas = document.querySelector<HTMLCanvasElement>('.mahjong-scene')
      const settlement = document.querySelector<HTMLElement>('.round-settlement')
      const csvNumbers = (value: string | undefined) => (value ?? '')
        .split(',')
        .filter((entry) => entry !== '')
        .map(Number)
        .filter(Number.isFinite)
      type PlayerProbe = { seat?: unknown; hand?: unknown }
      type VueInstance = { props?: Record<string, unknown>; parent?: VueInstance | null }
      let revealedFaceCounts: number[] = []
      let revealHands = false
      let instance = (hud as (HTMLElement & { __vueParentComponent?: VueInstance }) | null)
        ?.__vueParentComponent
      while (instance) {
        const players = instance.props?.players
        if (Array.isArray(players) && 'revealHands' in (instance.props ?? {})) {
          revealedFaceCounts = (players as PlayerProbe[])
            .map((player, index) => ({
              seat: typeof player.seat === 'number' ? player.seat : index,
              count: Array.isArray(player.hand) ? player.hand.length : 0,
            }))
            .sort((left, right) => left.seat - right.seat)
            .map((entry) => entry.count)
          revealHands = Boolean(instance.props?.revealHands)
          break
        }
        instance = instance.parent ?? undefined
      }
      const current: WinPhaseSample = {
        at: Date.now(),
        hand: document.querySelector('.round-info')?.textContent?.trim() ?? '',
        phase: hud?.dataset.phase ?? '',
        wallCount: Number(hud?.dataset.wallCount ?? -1),
        wallHeadDrawn: Number(hud?.dataset.wallHeadDrawn ?? -1),
        seats: csvNumbers(hud?.dataset.tableSeats),
        concealedCounts: csvNumbers(hud?.dataset.concealedCounts),
        revealedFaceCounts,
        revealHands,
        discardCounts: csvNumbers(hud?.dataset.discardCounts),
        meldTileCounts: csvNumbers(hud?.dataset.meldTileCounts),
        winEffectVisible: Number(hud?.dataset.winEffectId ?? -1) >= 0,
        settlementVisible: visible(settlement),
        confirmed: visible(document.querySelector<HTMLElement>('.remote-banner'))
          || Boolean(settlement?.querySelector<HTMLButtonElement>('.result-actions button:disabled')),
        tablePresent: Boolean(hud && canvas && canvas.width > 0 && canvas.height > 0),
      }
      const signature = JSON.stringify({ ...current, at: 0 })
      if (signature === previous && current.at - previousAt < 250) return
      previous = signature
      previousAt = current.at
      target.__onlineWinPhaseSamples?.push(current)
    }
    const observer = new MutationObserver(sample)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    target.__onlineWinPhaseObserver = observer
    target.__onlineWinPhaseSampler = window.setInterval(sample, 20)
    sample()
  })
}

async function winPhaseHistory(page: Page): Promise<WinPhaseSample[]> {
  return page.evaluate(() => (
    (window as unknown as { __onlineWinPhaseSamples?: WinPhaseSample[] }).__onlineWinPhaseSamples ?? []
  ))
}

function publicCounts(sample: WinPhaseSample) {
  return {
    wallCount: sample.wallCount,
    wallHeadDrawn: sample.wallHeadDrawn,
    seats: sample.seats,
    concealedCounts: sample.concealedCounts,
    discardCounts: sample.discardCounts,
    meldTileCounts: sample.meldTileCounts,
  }
}

function winningWindow(history: WinPhaseSample[], currentKey: string) {
  const start = history.findIndex((sample) => (
    handKey(sample.hand) === currentKey
    && (sample.winEffectVisible || sample.phase === 'win-effect')
  ))
  if (start < 0) return []
  const winning = history[start]
  let end = history.length
  for (let index = start + 1; index < history.length; index += 1) {
    const sample = history[index]
    const key = handKey(sample.hand)
    // 自动确认后 round-info 可能仍短暂显示上一手，但牌墙已先重置为下一手的
    // 136/0。牌墙回增或摸牌进度回退就是下一手切换事实，必须从胡牌窗口截断。
    const wallReset = winning.wallCount > 0 && sample.wallCount > winning.wallCount
      || winning.wallHeadDrawn >= 0 && sample.wallHeadDrawn < winning.wallHeadDrawn
    if (sample.phase === 'opening' || sample.phase === 'dealing'
      || (key && key !== currentKey) || wallReset) {
      end = index
      break
    }
  }
  return history.slice(Math.max(0, start - 1), end)
}

async function verifyWinningPhaseIntegrity(
  pages: [Page, Page],
  currentKey: string,
  scenario: string,
  testInfo: TestInfo,
) {
  const histories = await Promise.all(pages.map(winPhaseHistory))
  const windows = histories.map((history) => winningWindow(history, currentKey))
  // 先写原始窗口再断言；任一完整性断言失败时仍保留可复核数值证据。
  await testInfo.attach(`win-phase-integrity-${scenario}-${currentKey.replace(':', '-')}`, {
    body: JSON.stringify({
      scenario, currentKey,
      host: windows[0],
      client: windows[1],
    }, null, 2),
    contentType: 'application/json',
  })
  for (let sideIndex = 0; sideIndex < windows.length; sideIndex += 1) {
    const side = sideIndex === 0 ? '房主' : '客户端'
    const samples = windows[sideIndex]
    expect(samples.length, `${scenario}${side}未采集到 ${currentKey} 胡牌阶段`).toBeGreaterThan(2)
    const winIndex = samples.findIndex((sample) => sample.winEffectVisible || sample.phase === 'win-effect')
    expect(winIndex, `${scenario}${side}缺少真实胡牌特效阶段`).toBeGreaterThanOrEqual(0)
    expect(samples.some((sample) => sample.settlementVisible), `${scenario}${side}缺少结算展示阶段`).toBe(true)
    expect(samples.filter((sample) => !sample.tablePresent), `${scenario}${side}胡牌到切局期间牌桌不得消失`).toEqual([])

    const beforeWin = samples[Math.max(0, winIndex - 1)]
    const atWin = samples[winIndex]
    const active = samples.slice(winIndex)
    expect(atWin.wallCount, `${scenario}${side}胡牌阶段牌山不得归零`).toBeGreaterThan(0)
    expect(active.filter((sample) => sample.wallCount <= 0), `${scenario}${side}胡牌后牌山不得突然消失`).toEqual([])
    expect(Math.abs(beforeWin.wallCount - atWin.wallCount), `${scenario}${side}进入胡牌阶段牌山数量不得突变`).toBeLessThanOrEqual(1)
    expect(new Set(active.map((sample) => sample.wallCount)).size,
      `${scenario}${side}胡牌后牌山数量应保持稳定`).toBe(1)
    expect(new Set(active.map((sample) => sample.wallHeadDrawn)).size,
      `${scenario}${side}胡牌后牌山进度应保持稳定`).toBe(1)

    const concealedAtWin = atWin.concealedCounts
    expect(concealedAtWin).toHaveLength(4)
    expect(concealedAtWin.reduce((sum, count) => sum + count, 0),
      `${scenario}${side}胡牌阶段四家暗手不得整体消失`).toBeGreaterThan(0)
    for (const sample of active) {
      expect(sample.seats, `${scenario}${side}胡牌阶段应持续保留四个座位`).toEqual(atWin.seats)
      expect(sample.concealedCounts.reduce((sum, count) => sum + count, 0),
        `${scenario}${side}胡牌后四家暗手不得整体清零`).toBeGreaterThan(0)
      concealedAtWin.forEach((count, index) => {
        if (count > 0) expect(sample.concealedCounts[index],
          `${scenario}${side}座位 ${atWin.seats[index]} 的暗手不得突然消失`).toBeGreaterThan(0)
      })
      expect(sample.meldTileCounts, `${scenario}${side}胡牌后副露不得消失`).toEqual(atWin.meldTileCounts)
      expect(sample.discardCounts, `${scenario}${side}胡牌后牌河不得继续回退或整体清零`).toEqual(atWin.discardCounts)
    }

    // 进入亮牌/结算后，每一家不仅要保留“暗手张数”，还必须真正收到可展示的
    // 最终牌面。旧缺陷保留 concealedTileCount=13 却把 hand=[]，数量检查会误过，
    // 画面上则是另外三家的牌瞬间消失。
    const revealSamples = active.filter((sample) => sample.revealHands)
    expect(revealSamples.length, `${scenario}${side}胡牌后必须进入亮明四家手牌阶段`).toBeGreaterThan(0)
    for (const sample of revealSamples) {
      expect(sample.revealedFaceCounts, `${scenario}${side}亮牌阶段必须采集四家真实牌面张数`).toHaveLength(4)
      expect(sample.revealedFaceCounts, `${scenario}${side}亮牌阶段真实牌面数必须等于各家暗手数`)
        .toEqual(sample.concealedCounts)
      expect(sample.revealedFaceCounts.every((count) => count > 0),
        `${scenario}${side}亮牌阶段不得有任何一家保持空手牌`).toBe(true)
    }

    // 点炮牌进入胡牌区时允许从牌河移走且最多只移走一张；其它牌河和副露
    // 在胡牌边界本身也不得被清空。
    const discardDrop = beforeWin.discardCounts.reduce((sum, count, index) => (
      sum + Math.max(0, count - (atWin.discardCounts[index] ?? 0))
    ), 0)
    expect(discardDrop, `${scenario}${side}进入胡牌阶段牌河最多移走点炮牌一张`).toBeLessThanOrEqual(1)
    expect(atWin.meldTileCounts, `${scenario}${side}进入胡牌阶段副露不得突变`).toEqual(beforeWin.meldTileCounts)
  }

  const milestones = windows.map((samples) => ({
    win: samples.find((sample) => sample.winEffectVisible || sample.phase === 'win-effect')!,
    settled: samples.find((sample) => sample.settlementVisible)!,
    last: samples.at(-1)!,
  }))
  for (const milestone of ['win', 'settled', 'last'] as const) {
    expect(publicCounts(milestones[1][milestone]),
      `${scenario}${currentKey} 双端${milestone}阶段牌山/暗手/牌河/副露计数不一致`)
      .toEqual(publicCounts(milestones[0][milestone]))
  }
  console.log(`[确认专项][${scenario}] ${currentKey} 胡牌到切局期间牌山、暗手、牌河、副露均保持完整`)
}

async function expectSingleConfirmationState(
  confirmed: Page,
  pending: Page,
  scenario: string,
) {
  await expect(confirmed.locator('.remote-banner')).toBeVisible({ timeout: 5000 })
  await expect(pending.locator('.remote-banner')).toBeHidden({ timeout: 5000 })
  console.log(`[确认专项][${scenario}] 单边确认状态已生效，另一端仍未确认`)
}

/**
 * 开局时序采样器：MutationObserver + 20ms 定时器双保险。优先读 .game-table-hud
 * 的 data-* 可见状态；生产构建可能不暴露 Vue props，因此回退到 .mahjong-scene
 * 的 Vue 实例链。cycle 按 round-info 局号（含本场）变化推进。
 */
async function installOpeningSampler(page: Page) {
  await page.evaluate(() => {
    const target = window as unknown as {
      __onlineOpeningStages?: OpeningSample[]
      __onlineOpeningElements?: Array<{ at: number; hand: string; elements: string }>
      __onlineOpeningSampler?: number
      __onlineOpeningObserver?: MutationObserver
    }
    target.__onlineOpeningStages = []
    target.__onlineOpeningElements = []
    let previous = '__unset__'
    let previousStage: string | null = null
    let previousHandLabel = ''
    let lastProbe = ''
    let cycle = 0
    const numberValue = (value: string | undefined, fallback = -1) => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const sample = () => {
      type VueInstance = { props?: Record<string, unknown>; parent?: VueInstance | null }
      let props: Record<string, unknown> = {}
      // 动画元素监视：无论 stage 是否为空都记录关键 DOM 元素的存在，
      // 用于区分「动画播放了但采样丢失」与「动画根本没播放」。
      const elementProbe = [
        document.querySelector('.opening-overlay.start-cue') ? 'start-cue' : '',
        document.querySelector('.hand-rack.dealing') ? 'dealing' : '',
        document.querySelector('.second-dice-note') ? 'second-dice' : '',
        document.querySelector('.flip-indicator') ? 'flip-ind' : '',
      ].filter(Boolean).join('+')
      const probeKey = `${target.__onlineOpeningStages?.length ?? 0}:${elementProbe}`
      if (elementProbe && lastProbe !== probeKey) {
        lastProbe = probeKey
        target.__onlineOpeningElements?.push({
          at: performance.now(),
          hand: document.querySelector('.round-info')?.textContent?.trim() ?? '',
          elements: elementProbe,
        })
      }
      const hud = document.querySelector<HTMLElement>('.game-table-hud')
      if (hud) {
        const effectId = numberValue(hud.dataset.winEffectId)
        props = {
          openingStage: hud.dataset.openingStage || null,
          diceValues: (hud.dataset.diceValues ?? '').split(',').filter(Boolean).map(Number),
          diceThrowerIndex: numberValue(hud.dataset.diceThrowerIndex),
          wallBreakIndex: numberValue(hud.dataset.wallBreakIndex),
          flipStack: hud.dataset.flipStack ? numberValue(hud.dataset.flipStack) : null,
          wallCount: numberValue(hud.dataset.wallCount),
          wallHeadDrawn: numberValue(hud.dataset.wallHeadDrawn),
          dealAnimation: {
            serial: numberValue(hud.dataset.dealSerial),
            count: numberValue(hud.dataset.dealCount),
          },
          winEffect: effectId >= 0 ? { id: effectId } : null,
        }
      } else {
        // 回退：开局动画早期 .game-table-hud 可能尚未挂载，改沿 3D 场景的
        // Vue 实例父链读取表现状态（与主回归 sampler 一致）。
        for (const element of document.querySelectorAll('.mahjong-scene')) {
          let instance = (element as Element & { __vueParentComponent?: VueInstance }).__vueParentComponent
          while (instance) {
            if (instance.props && 'openingStage' in instance.props && 'wallBreakIndex' in instance.props) {
              props = instance.props
              break
            }
            instance = instance.parent ?? undefined
          }
          if ('openingStage' in props) break
        }
      }
      let stage = typeof props.openingStage === 'string' ? props.openingStage : null
      if (stage == null) {
        if (document.querySelector('.opening-overlay.start-cue')) stage = 'start'
        else if (document.querySelector('.hand-rack.dealing')) stage = 'deal'
      }
      const handLabel = document.querySelector('.round-info')?.textContent?.trim() ?? ''
      if (handLabel && handLabel !== previousHandLabel) {
        previousHandLabel = handLabel
        cycle += 1
        previous = '__unset__'
        previousStage = null
      } else if (stage === 'start' && previousStage !== 'start' && previousStage != null) {
        // 开局动画的 start 阶段本身也是新一轮的边界：round-info 标签可能晚于
        // 动画阶段更新（东2局 start/dice/flip 时标签仍是东1局结算页），此时
        // 阶段采样会错误归属到上一 cycle。start 出现即代表新一局动画开始。
        cycle += 1
        previous = '__unset__'
        previousStage = null
      }
      previousStage = stage
      if (stage == null || stage.endsWith('-visible')) return
      const deal = props.dealAnimation as { serial?: unknown; count?: unknown } | undefined
      const signature = JSON.stringify({
        cycle, stage,
        diceValues: Array.isArray(props.diceValues) ? props.diceValues.join(',') : '',
        diceThrowerIndex: props.diceThrowerIndex,
        wallBreakIndex: props.wallBreakIndex,
        flipStack: props.flipStack,
        wallCount: props.wallCount,
        wallHeadDrawn: props.wallHeadDrawn,
        dealSerial: deal?.serial,
        dealCount: deal?.count,
      })
      if (signature === previous) return
      previous = signature
      target.__onlineOpeningStages?.push({
        at: performance.now(),
        cycle,
        hand: handLabel,
        stage,
        diceValues: Array.isArray(props.diceValues)
          ? props.diceValues.filter((value): value is number => typeof value === 'number')
          : [],
        diceThrowerIndex: typeof props.diceThrowerIndex === 'number' ? props.diceThrowerIndex : -1,
        wallBreakIndex: typeof props.wallBreakIndex === 'number' ? props.wallBreakIndex : -1,
        flipStack: typeof props.flipStack === 'number' ? props.flipStack : null,
        wallCount: typeof props.wallCount === 'number' ? props.wallCount : -1,
        wallHeadDrawn: typeof props.wallHeadDrawn === 'number' ? props.wallHeadDrawn : -1,
        dealSerial: typeof deal?.serial === 'number' ? deal.serial : -1,
        dealCount: typeof deal?.count === 'number' ? deal.count : -1,
      })
    }
    const observer = new MutationObserver(sample)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    target.__onlineOpeningObserver = observer
    target.__onlineOpeningSampler = window.setInterval(sample, 20)
  })
}

async function openingHistory(page: Page): Promise<OpeningSample[]> {
  return page.evaluate(() => {
    const target = window as unknown as { __onlineOpeningStages?: OpeningSample[] }
    return target.__onlineOpeningStages ?? []
  })
}

async function openingElementHistory(page: Page): Promise<Array<{ at: number; hand: string; elements: string }>> {
  return page.evaluate(() => {
    const target = window as unknown as { __onlineOpeningElements?: Array<{ at: number; hand: string; elements: string }> }
    return target.__onlineOpeningElements ?? []
  })
}

/**
 * 验证一次完整开局时序（用户验收口径）：
 * 136 张/断点 0 → 一骰 → 翻精 134 张 → 二骰 → 应用真实断点 → 分批发牌。
 * 传入该局（cycle）的全部采样；按阶段断言时序与数值。
 * completion 来自实时探针（动画结束瞬间的牌墙状态）：发牌完成证明由
 * 「采样器走完 53 张」或「探针完成态」任一成立，因为 150ms 间隔的尾部
 * 单张批次在高负载（软件 WebGL）下可能被任一路径漏掉。
 */
function validateOpeningSequence(
  samples: OpeningSample[],
  side: string,
  label: string,
  testInfo: TestInfo,
  completion: { wallHeadDrawn: number; wallCount: number } | null,
): void {
  const stages = samples.map((sample) => sample.stage)
  expect(stages, `${label}${side}开局缺少开始提示`).toContain('start')
  expect(stages, `${label}${side}开局缺少掷骰`).toContain('dice')
  expect(stages, `${label}${side}开局缺少翻精`).toContain('flip')
  expect(stages, `${label}${side}开局缺少发牌`).toContain('deal')

  const dice = samples.filter((sample) => sample.stage === 'dice')
  expect(dice.length, `${label}${side}开局没有两次掷骰`).toBeGreaterThanOrEqual(2)
  const firstDice = dice[0]
  const secondDice = dice.at(-1)!
  for (const sample of [firstDice, secondDice]) {
    expect(sample.diceValues).toHaveLength(2)
    expect(sample.diceValues.every((value) => Number.isInteger(value) && value >= 1 && value <= 6)).toBe(true)
    expect(sample.diceThrowerIndex).toBeGreaterThanOrEqual(0)
    expect(sample.diceThrowerIndex).toBeLessThan(4)
  }

  // 翻精：翻出指示牌后牌山应变为 134 张（136 - 2）；断点此时必须仍是 0。
  const flip = samples.find((sample) => sample.stage === 'flip')
  expect(flip, `${label}${side}缺少翻精采样`).toBeTruthy()
  expect(flip!.wallCount, `${label}${side}翻精后牌山应为 134 张`).toBe(134)
  expect(flip!.wallBreakIndex, `${label}${side}翻精阶段牌山断点应保持 0（不能提前跳位）`).toBe(0)

  // 一骰/二骰阶段：牌山仍为 136（翻精前）/134（翻精后），断点必须保持 0。
  expect(firstDice.wallCount, `${label}${side}一骰阶段牌山应为 136 张`).toBe(136)
  expect(firstDice.wallBreakIndex, `${label}${side}一骰阶段断点应保持 0`).toBe(0)
  expect(secondDice.wallCount, `${label}${side}二骰阶段牌山应为 134 张`).toBe(134)
  expect(secondDice.wallBreakIndex, `${label}${side}二骰阶段断点应保持 0`).toBe(0)

  // 发牌：应用真实断点（flipStack + 二骰点数推导），断点不再为 0；
  // 分批发牌走完 53 张，牌山到 81 张。dealSerial 覆盖 12 批×4 张 +
  // 庄家补 2 张（serials 1-13）；尾部 4 张单张摸牌（14-17）间隔仅 150ms，
  // 高负载（WebGL 渲染）下采样器可能漏掉 1-2 个，因此阈值取 13（四张批
  // 次全部采到即可证明「分批发牌」；发牌完成由 completion 证明）。
  const deal = samples.filter((sample) => sample.stage === 'deal')
  expect(deal.length, `${label}${side}缺少发牌采样`).toBeGreaterThan(0)
  const expectedBreak = (((flip!.flipStack ?? 0) + secondDice.diceValues[0] + secondDice.diceValues[1] + 1) % 68) * 2
  const breakValues = [...new Set(deal.map((sample) => sample.wallBreakIndex))]
  expect(breakValues, `${label}${side}发牌期间牌山开口发生跳变（期望 ${expectedBreak}，实际 ${breakValues.join(',')}）`)
    .toEqual([expectedBreak])
  expect(deal[0].wallBreakIndex, `${label}${side}发牌开始时必须应用真实断点`).not.toBe(0)
  expect(Math.max(...deal.map((sample) => sample.dealSerial)),
    `${label}${side}发牌批次不完整`).toBeGreaterThanOrEqual(13)
  // 采样器侧：发牌必须推进到尾部（允许漏掉最后几个 150ms 单张样本）。
  expect(Math.max(...deal.map((sample) => sample.wallHeadDrawn)),
    `${label}${side}采样器发牌进度不足（headDrawn=${Math.max(...deal.map((sample) => sample.wallHeadDrawn))}）`)
    .toBeGreaterThanOrEqual(48)
  // 发牌完成证明：采样器自身走完 53 张（headDrawn=53 的样本 wallCount=81），
  // 或实时探针在动画结束瞬间看到完成态。任一证据成立即通过——两条路径
  // 都可能因 WebGL 高负载漏掉尾部 150ms 单张批次或精确 81 采样窗口。
  const samplerMaxHead = Math.max(...deal.map((sample) => sample.wallHeadDrawn))
  const samplerMinWall = Math.min(...deal.map((sample) => sample.wallCount))
  const samplerCompleted = samplerMaxHead >= 53 && samplerMinWall <= 81 && samplerMinWall >= 78
  const probeCompleted = completion != null
    && completion.wallHeadDrawn >= 53 && completion.wallCount >= 78 && completion.wallCount <= 81
  expect(samplerCompleted || probeCompleted,
    `${label}${side}发牌未完成（采样器 headDrawn=${samplerMaxHead} wallCount=${samplerMinWall}；探针 completion=${completion ? `${completion.wallHeadDrawn}/${completion.wallCount}` : '(未见)'}）`)
    .toBe(true)
}

/** 取指定 hand 文本（round-info）对应的开局 cycle 采样并验证完整时序。 */
async function verifyOpeningForHand(
  page: Page,
  handText: string,
  side: string,
  label: string,
  testInfo: TestInfo,
) {
  // waitForNextHand 在新手标签出现时就返回，发牌动画可能仍在进行；先等待
  // 该局 round-info 出现且开局发牌走完（牌山到 81 张 / headDrawn 到 53），
  // 再取采样做完整时序断言。注意不能用全局的 53/81（东1局结算时已满足），
  // 必须等目标局的标签出现后再等动画完成。
  const expectedRound = handText.match(/东[1-4]局/)?.[0] ?? ''
  // headless 软件 WebGL + 双 context 共享 CPU 时，开局动画（尤其尾部 150ms
  // 单张批次）可能慢到数十秒；固定窗口会被部分发牌截断，因此用
  // 「探针捕获完成态」+「采样器历史稳定」双信号，预算各 120 秒。
  const dealDeadline = Date.now() + 120_000
  let handSeen = false
  // 高频元素监视：抓取目标局动画期间的关键 DOM 元素（即使 sampler 漏采样）。
  const liveProbe: string[] = []
  // 每次轮询的原始状态（诊断用，最多保留最近 30 条）。
  const pollStates: string[] = []
  let pollErrors = 0
  // 发牌完成瞬间的牌墙状态（实时探针，动画结束后 stage 即清空）。
  let completion: { wallHeadDrawn: number; wallCount: number } | null = null
  while (Date.now() < dealDeadline) {
    // 短超时：WebGL 页面主线程偶发被长时间占用，评估调用不能吃掉整个轮询预算。
    const state = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>('.game-table-hud')
      const label = document.querySelector('.round-info')?.textContent?.trim() ?? ''
      const probe = [
        document.querySelector('.opening-overlay.start-cue') ? 'start-cue' : '',
        document.querySelector('.hand-rack.dealing') ? 'dealing' : '',
        document.querySelector('.second-dice-note') ? 'second-dice' : '',
        document.querySelector('.flip-indicator') ? 'flip-ind' : '',
      ].filter(Boolean).join('+')
      return {
        label,
        probe,
        wallHeadDrawn: element ? Number(element.dataset.wallHeadDrawn ?? -1) : -1,
        wallCount: element ? Number(element.dataset.wallCount ?? -1) : -1,
        stage: element?.dataset.openingStage || null,
        flipStack: element?.dataset.flipStack || null,
        wallBreakIndex: element?.dataset.wallBreakIndex || null,
      }
    }, { timeout: 4000 }).catch(() => null)
    if (state) {
      const pollKey = `${state.label || '(空)'}|${state.probe}|${state.stage}|${state.wallHeadDrawn}|${state.wallCount}`
      if (pollStates[pollStates.length - 1] !== pollKey) pollStates.push(pollKey)
      if (pollStates.length > 30) pollStates.splice(0, pollStates.length - 30)
    } else {
      pollErrors += 1
    }
    if (state && state.label && state.label.includes(expectedRound)) {
      handSeen = true
      const probeKey = `${state.probe}|${state.stage}|${state.flipStack}|${state.wallBreakIndex}|${state.wallCount}`
      if (liveProbe[liveProbe.length - 1] !== probeKey) liveProbe.push(probeKey)
    }
    if (handSeen && state && state.wallHeadDrawn >= 53 && state.wallCount === 81 && !state.stage) {
      completion = { wallHeadDrawn: state.wallHeadDrawn, wallCount: state.wallCount }
      break
    }
    await page.waitForTimeout(200)
  }
  // 等采样器历史稳定（开局动画结束、无新样本）后再读历史：慢速动画下
  // 探针轮询可能漏掉尾部批次，采样器自身是完整时序的最可靠来源。
  {
    const stabilizeDeadline = Date.now() + 120_000
    let lastLen = -1
    let stableSince = 0
    while (Date.now() < stabilizeDeadline) {
      const len = (await openingHistory(page)).length
      if (len === lastLen && len > 0) {
        if (!stableSince) stableSince = Date.now()
        if (Date.now() - stableSince > 2000) break
      } else {
        lastLen = len
        stableSince = 0
      }
      await page.waitForTimeout(400)
    }
  }
  if (!completion && handSeen) {
    // 兜底：未能捕捉精确 81 窗口（首回合摸牌/杠补已把牌山推进）时，用最后
    // 一次可见的完成态（headDrawn≥53、动画已结束）作为发牌完成证据。
    const last = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>('.game-table-hud')
      const label = document.querySelector('.round-info')?.textContent?.trim() ?? ''
      return {
        label,
        wallHeadDrawn: element ? Number(element.dataset.wallHeadDrawn ?? -1) : -1,
        wallCount: element ? Number(element.dataset.wallCount ?? -1) : -1,
        stage: element?.dataset.openingStage || null,
      }
    }, { timeout: 4000 }).catch(() => null)
    if (last && last.label.includes(expectedRound) && last.wallHeadDrawn >= 53 && !last.stage) {
      completion = { wallHeadDrawn: last.wallHeadDrawn, wallCount: last.wallCount }
    }
  }
  if (liveProbe.length > 0) {
    console.log(`[确认专项] ${label}${side} 目标局动画实时探针：${liveProbe.slice(0, 12).join(' | ')}`)
  }
  if (!completion) {
    // 诊断：dump 完整轮询轨迹（标签/元素/stage/headDrawn/wallCount），
    // 区分「动画真的没播完」与「探针采样窗口错失」。
    await testInfo.attach(`opening-probe-dump-${label}-${side}`, {
      body: JSON.stringify({
        expectedRound, handSeen, pollErrors, completion,
        liveProbe: liveProbe.slice(-25),
        pollStates: pollStates.slice(-25),
      }),
      contentType: 'application/json',
    })
    console.log(`[确认专项] ${label}${side} 探针未见完成态：handSeen=${handSeen} pollErrors=${pollErrors} 轮询=${pollStates.slice(-12).join(' | ') || '(无)'}`)
  }
  const history = await openingHistory(page)
  const handKeyOf = (value: string) => {
    const round = value.match(/东[1-4]局/)?.[0] ?? ''
    const honba = value.match(/(\d+)本场/)?.[1] ?? '0'
    return round ? `${round}:${honba}` : ''
  }
  const expectedKey = handKeyOf(handText)
  const cycles = new Map<number, OpeningSample[]>()
  for (const sample of history) {
    if (sample.cycle < 1) continue
    if (handKeyOf(sample.hand) !== expectedKey) continue
    const entries = cycles.get(sample.cycle) ?? []
    entries.push(sample)
    cycles.set(sample.cycle, entries)
  }
  const matching = [...cycles.values()].at(-1)
  if (!matching) {
    // 诊断：dump 两端完整 history 摘要（cycle/stage/hand/数值），区分
    // 「开局动画根本没播放」与「播放了但采样归属到其他 cycle」。
    const summary = history.map((s) => (
      `${s.cycle}:${s.hand ? handKeyOf(s.hand) : '(空)'}:${s.stage}:w${s.wallCount}:b${s.wallBreakIndex}:h${s.wallHeadDrawn}`
    )).slice(-25)
    const elementSummary = (await openingElementHistory(page)).slice(-15)
    await testInfo.attach(`opening-history-dump-${label}-${side}`, {
      body: JSON.stringify({
        expectedKey, historyLength: history.length, summary,
        elementEvents: elementSummary.map((e) => `${e.hand}:${e.elements}`),
        liveProbe,
      }),
      contentType: 'application/json',
    })
    console.log(`[确认专项] ${label}${side} history 摘要：${summary.join(' | ')}`)
    console.log(`[确认专项] ${label}${side} 动画元素监视：${elementSummary.map((e) => `${e.hand}:${e.elements}`).join(' | ')}`)
    console.log(`[确认专项] ${label}${side} 实时探针：${liveProbe.slice(0, 12).join(' | ')}`)
  }
  expect(matching, `${label}${side}未采集到 ${handText} 的开局时序（history=${history.length} 条，hand=${history.map((s) => `${s.cycle}:${s.hand}`).slice(-4).join(' | ')}）`).toBeTruthy()
  validateOpeningSequence(matching!, side, label, testInfo, completion)
  await testInfo.attach(`opening-sequence-${label}-${side}`, {
    body: JSON.stringify(matching!.map((s) => ({
      stage: s.stage, wallCount: s.wallCount, wallBreakIndex: s.wallBreakIndex,
      wallHeadDrawn: s.wallHeadDrawn, dealSerial: s.dealSerial, dice: s.diceValues,
      flipStack: s.flipStack,
    }))),
    contentType: 'application/json',
  })
  console.log(`[确认专项] ${label}${side} 开局时序通过：${matching!.map((s) => s.stage).join(' → ')}`)
}

/** 断言一段「无确认窗口」内屏障生效：房主结算层保持等待状态，两端未推进到下一手。 */
async function assertBarrierHolds(
  host: Page,
  client: Page,
  currentKey: string,
  windowMs: number,
  hostLogs: string[],
  testInfo: TestInfo,
  label: string,
) {
  const sample: string[] = []
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    const hostLabel = await readRoundLabel(host)
    const clientLabel = await readRoundLabel(client)
    const hostSettlement = await settlementVisible(host)
    const clientSettlement = await settlementVisible(client)
    const hostAdvanced = hostLabel && handKey(hostLabel) !== currentKey
    const clientAdvanced = clientLabel && handKey(clientLabel) !== currentKey

    if (hostAdvanced || clientAdvanced) {
      // 推进时收集现场证据：两端标签、结算层可见性、房主关键日志。
      await testInfo.attach(`barrier-broken-${label}`, {
        body: JSON.stringify({
          hostLabel: hostLabel || '(空)', clientLabel: clientLabel || '(空)',
          hostSettlement, clientSettlement,
          hostLogTail: hostLogs.slice(-15),
        }),
        contentType: 'application/json',
      })
      throw new Error(
        `严格屏障被绕过：${label} 未确认期间推进（host=${hostLabel || '(空)'} client=${clientLabel || '(空)'}）`,
      )
    }
    // 屏障生效的正面证据：房主结算层仍在（等待其他玩家确认）。
    if (!hostSettlement) {
      sample.push(`t+${Date.now() - (deadline - windowMs)}ms host-settlement-absent hostLabel=${hostLabel || '(空)'}`)
    }
    await host.waitForTimeout(500)
  }
  await testInfo.attach(`barrier-samples-${label}`, {
    body: JSON.stringify({ currentKey, samples: sample.slice(0, 20) }),
    contentType: 'application/json',
  })
  console.log(`[确认专项] ${label} 在 ${Math.round(windowMs / 1000)}s 无确认窗口内屏障生效（未推进）`)
}

test('结算确认三场景：双端自动确认 / 仅房主确认 / 仅客户端确认', async ({}, testInfo) => {
  const suffix = Date.now().toString(36).slice(-5)

  // ── 场景 A：双方都不确认 → 生产默认 10 秒自动确认 → 自动进入下一手 ──
  {
    const autoPair = await launchAccountBrowserPair()
    const { contexts } = autoPair
    try {
      const pages = [
        await authenticateAccount(autoPair, 0, ONLINE.accounts[0], false),
        await authenticateAccount(autoPair, 1, ONLINE.accounts[1], false),
      ]
      const [host, client] = pages
      const hostLogs: string[] = []
      const clientLogs: string[] = []
      attachConsoleCapture(host, hostLogs)
      attachConsoleCapture(client, clientLogs)
      const { roomCode, winningKey } = await startEastHandToSettlement(host, client, `A-${suffix}`, false)
      const transitionLogOffsets = [hostLogs.length, clientLogs.length] as const
      const settledAt = Date.now()
      // 关键：两端都不点击确认；生产默认 10 秒倒计时应自动确认并进入下一手。
      console.log(`[确认专项][场景A] ${roomCode} ${winningKey} 胡牌结算，两端均不手动确认，等待自动确认`)
      const next = await waitForNextHand(host, client, winningKey, 180_000)
      const autoConfirmMs = Date.now() - settledAt
      console.log(`[确认专项][场景A] 自动确认耗时 ${autoConfirmMs}ms，进入 ${next.hostLabel} | ${next.clientLabel}`)

      // 先排除外部连接恢复和异常慢推进，再核验开局动画。否则一次真实的
      // reconnect/rejoin 会让客户端从中途补播旧开局，表现成“采样器漏记”。
      const hostRecovery = recoveryLogsSince(hostLogs, transitionLogOffsets[0])
      const clientRecovery = recoveryLogsSince(clientLogs, transitionLogOffsets[1])
      await testInfo.attach('scenario-A-auto-confirm', {
        body: JSON.stringify({
          roomCode, winningKey, autoConfirmMs,
          hostNext: next.hostLabel, clientNext: next.clientLabel,
          hostRecoveryLogs: hostRecovery.slice(-10),
          clientRecoveryLogs: clientRecovery.slice(-10),
        }),
        contentType: 'application/json',
      })
      expect(autoConfirmMs, `自动确认耗时 ${autoConfirmMs}ms 应处于合理窗口（10s 倒计时 + 切局开销）`)
        .toBeGreaterThan(8_000)
      expect(autoConfirmMs, `自动确认耗时 ${autoConfirmMs}ms 不应超过 60s`).toBeLessThan(60_000)
      expect(hostRecovery, `场景A 房主不应出现恢复/重进日志：${hostRecovery.join(' | ')}`).toEqual([])
      expect(clientRecovery, `场景A 客户端不应出现恢复/重进日志：${clientRecovery.join(' | ')}`).toEqual([])

      // 验收 0：自动确认进入的新一局必须走完整开局时序
      // （136/断点0 → 一骰 → 翻精134 → 二骰 → 应用真实断点 → 分批发牌）。
      try {
        await verifyOpeningForHand(host, next.hostLabel, '房主', '场景A-东2局', testInfo)
        await verifyOpeningForHand(client, next.clientLabel, '客户端', '场景A-东2局', testInfo)
        await verifyWinningPhaseIntegrity(pages as [Page, Page], winningKey, 'A-both-auto', testInfo)
      } catch (error) {
        // 输出两端 round_start/动画相关诊断日志，定位动画缺失环节。
        const rsLogs = (logs: string[]) => logs
          .filter((line) => /round_start|opening|reconciler|快照已配对|confirm|直接启动|结算页缓存/.test(line))
          .slice(-20)
        console.log(`[确认专项] 场景A 房主 round_start 日志：${rsLogs(hostLogs).join(' | ') || '(无)'}`)
        console.log(`[确认专项] 场景A 客户端 round_start 日志：${rsLogs(clientLogs).join(' | ') || '(无)'}`)
        await testInfo.attach('scenario-A-roundstart-logs', {
          body: JSON.stringify({
            hostRoundStart: rsLogs(hostLogs),
            clientRoundStart: rsLogs(clientLogs),
            hostDiag: hostLogs.filter((line) => /\[diag\]/.test(line)).slice(-20),
            clientDiag: clientLogs.filter((line) => /\[diag\]/.test(line)).slice(-20),
          }),
          contentType: 'application/json',
        })
        throw error
      }

      console.log(`[确认专项][场景A] 通过：自动确认 ${autoConfirmMs}ms 进入下一手，无恢复/重进日志`)
    } finally {
      await closeAccountBrowserPair(autoPair)
    }
  }

  // ── 场景 B + C：带 manualContinue=1，验证单边确认不推进 ──
  {
    const manualPair = await launchAccountBrowserPair()
    const { contexts: manualContexts } = manualPair
    try {
      const pages = [
        await authenticateAccount(manualPair, 0, ONLINE.accounts[0], true),
        await authenticateAccount(manualPair, 1, ONLINE.accounts[1], true),
      ]
      const [host, client] = pages
      const hostLogs: string[] = []
      const clientLogs: string[] = []
      attachConsoleCapture(host, hostLogs)
      attachConsoleCapture(client, clientLogs)

      // ── 场景 B：仅房主确认，客户端不确认 → 屏障阻止推进；客户端确认后进入下一手 ──
      {
        const { roomCode, winningKey } = await startEastHandToSettlement(host, client, `B-${suffix}`, true)
        const hostClicked = await clickContinue(host)
        expect(hostClicked, '房主应能点击继续').toBe(true)
        console.log(`[确认专项][场景B] ${roomCode} 仅房主确认，客户端不确认`)
        await expectSingleConfirmationState(host, client, '场景B')
        await assertBarrierHolds(host, client, winningKey, 25_000, hostLogs, testInfo, 'B-host-only')
        const clientClicked = await clickContinue(client)
        expect(clientClicked, '客户端补点继续').toBe(true)
        const next = await waitForNextHand(host, client, winningKey, 180_000)
        console.log(`[确认专项][场景B] 通过：屏障阻止单边推进，客户端确认后进入 ${next.hostLabel} | ${next.clientLabel}`)
        // 客户端确认后进入的新一局必须走完整开局时序。
        await verifyOpeningForHand(host, next.hostLabel, '房主', '场景B-下一手', testInfo)
        await verifyOpeningForHand(client, next.clientLabel, '客户端', '场景B-下一手', testInfo)
        await verifyWinningPhaseIntegrity(pages as [Page, Page], winningKey, 'B-host-only', testInfo)
        await testInfo.attach('scenario-B-host-only-confirm', {
          body: JSON.stringify({ roomCode, winningKey, hostNext: next.hostLabel, clientNext: next.clientLabel }),
          contentType: 'application/json',
        })
      }

      // ── 场景 C：仅客户端确认，房主不确认 → 屏障阻止推进；房主确认后进入下一手 ──
      {
        // 当前手可能是东2局或东1局·1本场（视 B 的手牌结果），取两端当前一致的手牌键。
        const hostLabel = await readRoundLabel(host)
        const clientLabel = await readRoundLabel(client)
        const currentKey = handKey(hostLabel) || handKey(clientLabel)
        expect(currentKey, `场景C 应处于有效手牌（host=${hostLabel} client=${clientLabel}）`).not.toBe('')
        const winningKey = await waitForWinningSettlement(host, client, currentKey, true)
        console.log(`[确认专项][场景C] ${winningKey} 双端胡牌结算，仅客户端确认，房主不确认`)
        const clientClicked = await clickContinue(client)
        expect(clientClicked, '客户端应能点击继续').toBe(true)
        await expectSingleConfirmationState(client, host, '场景C')
        await assertBarrierHolds(host, client, winningKey, 25_000, hostLogs, testInfo, 'C-client-only')
        const hostClicked = await clickContinue(host)
        expect(hostClicked, '房主补点继续').toBe(true)
        const next = await waitForNextHand(host, client, winningKey, 180_000)
        console.log(`[确认专项][场景C] 通过：屏障阻止单边推进，房主确认后进入 ${next.hostLabel} | ${next.clientLabel}`)
        // 房主确认后进入的新一局必须走完整开局时序。
        await verifyOpeningForHand(host, next.hostLabel, '房主', '场景C-下一手', testInfo)
        await verifyOpeningForHand(client, next.clientLabel, '客户端', '场景C-下一手', testInfo)
        await verifyWinningPhaseIntegrity(pages as [Page, Page], winningKey, 'C-client-only', testInfo)
        await testInfo.attach('scenario-C-client-only-confirm', {
          body: JSON.stringify({ winningKey, hostNext: next.hostLabel, clientNext: next.clientLabel }),
          contentType: 'application/json',
        })
      }
    } finally {
      await closeAccountBrowserPair(manualPair)
    }
  }

  console.log('[确认专项] 三场景全部通过')
})
