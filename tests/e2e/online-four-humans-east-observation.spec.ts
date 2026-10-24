// 3 个线上账号 + 1 位真人（用户自己）共 4 人，东风场 · 莲花麻将联机观测。
//
// - 从 tmp/online_test 读取 3 个用户，随机决定房主（建房者即房主）。
// - 房主创建房间（场次=东风场，玩法=莲花麻将 lotus-legacy），房间码输出到
//   [ROOM-CODE] 标记与 tmp/online-room-code.txt，供真人玩家加入。
// - 脚本的 3 个账号进房并准备；等待真人玩家加入并准备（房主「开始对局」按钮启用 =
//   4/4 全员就绪）后，由房主自动开始。
// - 对局期间脚本自动操作自己的 3 个账号（出牌/过/胡，结算亮牌后点继续），
//   真人的第 4 席由玩家本人操作（其页面带默认 10 秒自动确认与 12 秒自动出牌）。
// - 全程采集问题：SDK P2P 竞态、重连/重进、AI 接管、round_start 去重、牌山回退、
//   结算异常、页面异常、每手耗时等，最后输出问题清单。
// - 凭据与 URL 只在运行时从 tmp/online_test 读取，绝不写入日志/附件。
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { chromium, expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

interface Account { email: string; password: string }
interface OnlineConfig { url: string; accounts: Account[] }
interface FinalStanding { rank: number; name: string; score: number }
interface PageErrorRecord { at: number; name: string; message: string; stack: string }
interface OpeningStageSample { at: number; hand: string; stage: string; wallCount: number; wallHeadDrawn: number }
interface ObservedIssue { at: string; slot: number; category: string; message: string }

function readOnlineConfig(): OnlineConfig {
  const raw = readFileSync('tmp/online_test', 'utf8')
  const url = raw.match(/测试 url：([^\r\n]+)/)?.[1]?.trim()
  const accounts = [...raw.matchAll(/账号\d+：([^，\r\n]+)，密码：([^\r\n]+)/g)]
    .map((match) => ({ email: match[1].trim(), password: match[2].trim() }))
  if (!url || accounts.length < 3) throw new Error('tmp/online_test 缺少测试 URL 或三个账号')
  return { url, accounts: accounts.slice(0, 3) }
}

const ONLINE = readOnlineConfig()
test.setTimeout(6_000_000)

// ── 随机房主（默认完全随机；ONLINE_HOST_SLOT=1/2/3 可固定槽位复现）──
const HOST_SLOT = (() => {
  const forced = Number(process.env.ONLINE_HOST_SLOT)
  return Number.isInteger(forced) && forced >= 1 && forced <= 3 ? forced - 1 : Math.floor(Math.random() * 3)
})()
const GUEST_SLOTS = [0, 1, 2].filter((slot) => slot !== HOST_SLOT)

const ACCOUNT_BROWSER_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=IntensiveWakeUpThrottling',
]

const ACCOUNT_PROXY_SERVERS = (process.env.ONLINE_PROXY_SERVERS ?? '')
  .split(',')
  .map((server) => server.trim())
  .filter(Boolean)

function accountProxy(index: number): { proxy?: { server: string } } {
  const server = ACCOUNT_PROXY_SERVERS[index] ?? ACCOUNT_PROXY_SERVERS[0]
  return server ? { proxy: { server } } : {}
}

interface AccountBrowserTriple {
  browsers: Browser[]
  contexts: BrowserContext[]
}

async function launchAccountBrowsers(): Promise<AccountBrowserTriple> {
  const browsers = await Promise.all(ONLINE.accounts.map((_, index) => chromium.launch({
    headless: true,
    args: ACCOUNT_BROWSER_ARGS,
    ...accountProxy(index),
  })))
  try {
    const contexts = await Promise.all(browsers.map((browser) => browser.newContext({
      viewport: { width: 1280, height: 720 },
    })))
    return { browsers, contexts }
  } catch (error) {
    await Promise.allSettled(browsers.map((browser) => browser.close()))
    throw error
  }
}

async function closeAccountBrowsers(triple: AccountBrowserTriple) {
  await Promise.allSettled(triple.browsers.map((browser) => browser.close()))
}

const roundToken = (value: string) => value.match(/[东南][1-4]局/)?.[0] ?? ''
const handToken = (value: string) => {
  const round = value.match(/[东南][1-4]局/)?.[0] ?? ''
  const honba = value.match(/(\d+)本场/)?.[1] ?? '0'
  return round ? `${round}:${honba}` : ''
}
const settlementSignature = (text: string) => text
  .split('\n')
  .filter((line) => !/查看牌桌|继续(?:\s*\(\d+\))?|等待其他玩家|已确认/.test(line))
  .join('\n')

async function selectOnlineMode(page: Page) {
  await page.getByText('联机对战', { exact: false }).first().click()
}

async function authenticate(context: BrowserContext, account: Account) {
  const page = await context.newPage()
  const separator = ONLINE.url.includes('?') ? '&' : '?'
  const params = new URLSearchParams()
  // auto=1 = 生产内置「托管」开关直接开启（remoteGameState.autoPlayFromUrl：
  // ?auto=1 → autoPlay=true → 托管按钮 aria-pressed/active = 开启），
  // 出牌走 pickDiscard 智能策略（不拆听 → 不打癞子/精牌 → 听口更多）。
  params.set('auto', '1')
  params.set('manualContinue', '1') // 脚本账号手动点「继续」，便于验证亮牌后再确认。
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

interface TrusteeState { present: boolean; enabled: boolean; clicked: boolean }

async function readTrusteeState(page: Page): Promise<TrusteeState> {
  return page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('.action.autoplay-action')
    if (!button) return { present: false, enabled: false, clicked: false }
    const enabled = button.getAttribute('aria-pressed') === 'true' || button.classList.contains('active')
    return { present: true, enabled, clicked: false }
  }).catch(() => ({ present: false, enabled: false, clicked: false }))
}

/** 生产「托管」开关：已开启则不动（aria-pressed 是 Vue 绑定）；未开启则点一次并复验。
 * 若产品未显示托管按钮，返回 false 由调用方回退到 DOM 自动点击。 */
async function ensureTrustedAutoPlay(page: Page, label: string): Promise<boolean> {
  let state = await readTrusteeState(page)
  const presentDeadline = Date.now() + 15_000
  while (!state.present && Date.now() < presentDeadline) {
    await page.waitForTimeout(500)
    state = await readTrusteeState(page)
  }
  if (state.present && !state.enabled) {
    await page.locator('.action.autoplay-action').click().catch(() => {})
    await page.waitForTimeout(800)
    state = await readTrusteeState(page)
  }
  console.log(`[FOUR] ${label} 托管按钮: present=${state.present} enabled=${state.enabled}`)
  return state.present && state.enabled
}

interface AutoPlayerEvent { at: number; type: 'hu-click' | 'pass-click' | 'discard-click' }

async function installAutoPlayer(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as {
      __fourAuto?: number
      __fourAutoEvents?: AutoPlayerEvent[]
    }
    if (state.__fourAuto) return
    state.__fourAutoEvents = []
    state.__fourAuto = window.setInterval(() => {
      const actionBar = document.querySelector('.action-bar')
      if (actionBar) {
        const hu = actionBar.querySelector<HTMLButtonElement>('.action.hu')
        if (hu) {
          state.__fourAutoEvents?.push({ at: Date.now(), type: 'hu-click' })
          hu.click()
          return
        }
        const pass = actionBar.querySelector<HTMLButtonElement>('.action.pass')
        if (pass) {
          state.__fourAutoEvents?.push({ at: Date.now(), type: 'pass-click' })
          pass.click()
          return
        }
      }
      const tile = document.querySelector<HTMLElement>('.hand-rack.playable .hand-tile-slot .mahjong-tile')
      if (tile) {
        state.__fourAutoEvents?.push({ at: Date.now(), type: 'discard-click' })
        tile.click()
      }
    }, 120)
  })
}

async function readRoundLabel(page: Page) {
  return page.locator('.round-info').innerText({ timeout: 1000 }).catch(() => '')
}

async function readTableLoadState(page: Page) {
  return page.evaluate(() => {
    const loading = document.querySelector<HTMLElement>('.table-loading')
    const loadingCard = document.querySelector<HTMLElement>('.table-loading-card')
    const visible = (element: HTMLElement | null) => Boolean(element
      && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden'
      && getComputedStyle(element).display !== 'none'
      && Number(getComputedStyle(element).opacity) > 0)
    const canvas = document.querySelector<HTMLCanvasElement>('.mahjong-scene')
    return {
      loadingVisible: visible(loading),
      loadingCardText: visible(loadingCard) ? (loadingCard?.textContent?.trim() ?? '') : '',
      canvasPresent: Boolean(canvas),
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0,
      tileResources: performance.getEntriesByType('resource')
        .filter((entry) => /\/tiles\/.*\.png(?:\?|$)/.test(entry.name)).length,
    }
  }).catch(() => null)
}

interface HudSignals {
  phase: string
  openingStage: string
  wallCount: number
  wallHeadDrawn: number
  revealHands: boolean
  revealedFaceCounts: number[]
  matchFinished: boolean
}

async function readHudSignals(page: Page): Promise<HudSignals | null> {
  return page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>('.game-table-hud')
    if (!hud) return null
    const numbers = (value: string | undefined) => (value ?? '')
      .split(',')
      .filter((entry) => entry !== '')
      .map(Number)
      .filter(Number.isFinite)
    return {
      phase: hud.dataset.phase ?? '',
      openingStage: hud.dataset.openingStage ?? '',
      wallCount: Number(hud.dataset.wallCount ?? -1),
      wallHeadDrawn: Number(hud.dataset.wallHeadDrawn ?? -1),
      revealHands: hud.dataset.revealHands === '1',
      revealedFaceCounts: numbers(hud.dataset.revealedFaceCounts),
      matchFinished: hud.dataset.matchFinished === '1',
    }
  }).catch(() => null)
}

async function installOpeningSampler(page: Page) {
  await page.evaluate(() => {
    const target = window as unknown as {
      __fourOpeningStages?: OpeningStageSample[]
      __fourOpeningSampler?: number
    }
    if (target.__fourOpeningSampler) window.clearInterval(target.__fourOpeningSampler)
    target.__fourOpeningStages = []
    let previous = '__unset__'
    const sample = () => {
      const hud = document.querySelector<HTMLElement>('.game-table-hud')
      if (!hud) return
      const hand = document.querySelector('.round-info')?.textContent?.trim() ?? ''
      const stage = hud.dataset.openingStage ?? ''
      const wallCount = Number(hud.dataset.wallCount ?? -1)
      const wallHeadDrawn = Number(hud.dataset.wallHeadDrawn ?? -1)
      const signature = `${hand}|${stage}|${wallCount}|${wallHeadDrawn}`
      if (signature !== previous) {
        previous = signature
        target.__fourOpeningStages?.push({ at: Date.now(), hand, stage, wallCount, wallHeadDrawn })
      }
    }
    target.__fourOpeningSampler = window.setInterval(sample, 100)
  })
}

async function openingHistory(page: Page, stop = false): Promise<OpeningStageSample[]> {
  return page.evaluate((shouldStop) => {
    const target = window as unknown as {
      __fourOpeningStages?: OpeningStageSample[]
      __fourOpeningSampler?: number
    }
    if (shouldStop && target.__fourOpeningSampler) window.clearInterval(target.__fourOpeningSampler)
    return target.__fourOpeningStages ?? []
  }, stop)
}

async function readFinalStandings(page: Page): Promise<FinalStanding[]> {
  return page.locator('.final-rankings article').evaluateAll((articles) => articles.map((article) => ({
    rank: Number(article.querySelector('.final-rank b')?.textContent?.trim() ?? Number.NaN),
    name: article.querySelector('.final-name strong')?.textContent?.trim() ?? '',
    score: Number(article.querySelector('em')?.textContent?.trim() ?? Number.NaN),
  })))
}

async function attemptScreenshot(pages: Page[], testInfo: TestInfo, name: string) {
  try {
    for (let index = 0; index < pages.length; index += 1) {
      const body = await pages[index].screenshot({ timeout: 8000 })
      await testInfo.attach(`${name}-slot-${index + 1}`, { body, contentType: 'image/png' })
      await pages[index].waitForTimeout(100)
    }
  } catch (error) {
    console.log(`[spec] 截图 ${name} 超时/失败，跳过取证: ${String(error).slice(0, 160)}`)
  }
}

async function clickContinueIfAvailable(page: Page) {
  const button = page.locator('.round-settlement .result-actions button').filter({ hasText: /^继续/ }).first()
  if (!await button.isVisible().catch(() => false)) return false
  if (!await button.isEnabled().catch(() => false)) return false
  await button.evaluate((element: HTMLButtonElement) => element.click()).catch(() => {})
  return true
}

test('三个线上账号 + 一位真人玩家：东风场莲花麻将四人联机观测', async ({}, testInfo) => {
  const triple = await launchAccountBrowsers()
  let activePages: Page[] | null = null
  const issues: ObservedIssue[] = []
  try {
    console.log(`[FOUR] 随机房主 = tmp/online_test 账号槽位 ${HOST_SLOT + 1}；脚本客人槽位 ${GUEST_SLOTS.map((slot) => slot + 1).join('、')}；第 4 席等待真人加入`)
    const pages = await Promise.all(ONLINE.accounts.map((account, index) => (
      authenticate(triple.contexts[index], account)
    )))
    activePages = pages
    const consoleLogs = pages.map(() => [] as string[])
    const pageErrors = pages.map(() => [] as PageErrorRecord[])
    pages.forEach((page, index) => {
      const logFile = `tmp/online-four-humans-console-${index + 1}.log`
      appendFileSync(logFile, `\n===== 会话开始 ${new Date().toISOString()} =====\n`)
      page.on('pageerror', (error) => {
        pageErrors[index].push({ at: Date.now(), name: error.name, message: error.message, stack: error.stack ?? '' })
        issues.push({
          at: new Date().toISOString(), slot: index + 1, category: 'pageerror',
          message: `${error.name}: ${error.message}`,
        })
      })
      page.on('console', (message) => {
        const line = message.text()
        appendFileSync(logFile, `${new Date().toISOString()} [${message.type()}] ${line}\n`)
        if (/InvalidStateError|Failed to execute|setRemoteDescription|RTCPeerConnection/i.test(line)) {
          issues.push({ at: new Date().toISOString(), slot: index + 1, category: 'sdk-p2p', message: line.slice(0, 300) })
        }
        if (/先释放旧连接再重进|自动重进失败|尝试重新加入房间|恢复牌局|已验证重进握手|新 peer 已恢复原座位|权威连续静默|当前手牌事实单次请求/i.test(line)) {
          issues.push({ at: new Date().toISOString(), slot: index + 1, category: 'recovery', message: line.slice(0, 300) })
        }
        if (/AI 代打|AI 接管/i.test(line)) {
          issues.push({ at: new Date().toISOString(), slot: index + 1, category: 'ai-takeover', message: line.slice(0, 300) })
        }
        if (/round_start 丢弃\/去重|opening gate 拒绝快照|opening cancel|快照已落地但无动画数据/i.test(line)) {
          issues.push({ at: new Date().toISOString(), slot: index + 1, category: 'opening-dedup', message: line.slice(0, 300) })
        }
        if (/wall-regress|非法状态快照/i.test(line)) {
          issues.push({ at: new Date().toISOString(), slot: index + 1, category: 'wall-state', message: line.slice(0, 300) })
        }
        if (/\[host\]|\[client\]|\[diag\]|\[transport\]|心跳|主动重建|error|warn|丢弃|重进|洗牌|快照|continue|shuffle/i.test(line)) {
          consoleLogs[index].push(line)
        }
      })
    })
    const host = pages[HOST_SLOT]
    const guestPages = GUEST_SLOTS.map((slot) => pages[slot])
    const scriptPages = [host, ...guestPages]
    const suffix = Date.now().toString(36).slice(-5)

    // ── 房主建房：东风场 + 莲花麻将 ──
    await enterOnlineLobby(host, `线上房主-${suffix}`, 'host')
    await host.getByRole('button', { name: '创建房间', exact: true }).click()
    await host.locator('.lobby-dialog .game-settings button', { hasText: '场次' }).click()
    await host.getByRole('button', { name: /东风场/ }).click()
    await host.getByRole('button', { name: '确定', exact: true }).click()
    await host.locator('.lobby-dialog .game-settings button', { hasText: '玩法' }).click()
    await host.getByRole('button', { name: /莲花麻将/ }).click()
    await host.getByRole('button', { name: '确定', exact: true }).click()
    await host.getByRole('button', { name: '确认创建', exact: true }).click()
    await acceptDisclaimerIfShown(host)
    await host.locator('.room-code strong').waitFor({ timeout: 40_000 })
    const roomCode = (await host.locator('.room-code strong').innerText()).trim()
    expect(roomCode).toMatch(/^[A-Z0-9]{6}$/)
    writeFileSync('tmp/online-room-code.txt', roomCode)
    await testInfo.attach('room-code', { body: roomCode, contentType: 'text/plain' })
    console.log(`[ROOM-CODE] ${roomCode}`)
    console.log(`[FOUR] 房间 ${roomCode} 已创建（房主=账号槽位 ${HOST_SLOT + 1}，东风场·莲花麻将）。请真人玩家在第 4 席加入并点「准备」`)

    // ── 脚本两账号加入 ──
    for (let index = 0; index < guestPages.length; index += 1) {
      const guest = guestPages[index]
      await enterOnlineLobby(guest, `线上客人${index + 1}-${suffix}`, 'client')
      await guest.getByRole('button', { name: '加入房间', exact: true }).click()
      await guest.getByPlaceholder('输入 6 位房间码').fill(roomCode)
      await guest.getByRole('button', { name: '确认加入' }).click()
      await acceptDisclaimerIfShown(guest)
    }

    // ── 脚本三席位先准备 ──
    await Promise.all(scriptPages.map((page) => page.waitForFunction(() => (
      [...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => (
        button.textContent?.trim() === '准备 / 取消准备'
          && button.getClientRects().length > 0
      ))
    ), undefined, { timeout: 90_000, polling: 100 })))
    await Promise.all(scriptPages.map((page) => page.getByRole('button', { name: '准备 / 取消准备' }).click()))
    console.log('[FOUR] 3 个线上账号已准备，等待真人玩家加入并准备')

    // ── 等真人加入（4 席）──
    const joinDeadline = Date.now() + 25 * 60_000
    let seatCount = 0
    let lastJoinNotice = 0
    while (Date.now() < joinDeadline) {
      seatCount = await host.locator('.room-seat.occupied').count().catch(() => 0)
      if (seatCount >= 4) break
      if (Date.now() - lastJoinNotice > 30_000) {
        lastJoinNotice = Date.now()
        console.log(`[FOUR] 等待真人玩家加入房间 ${roomCode}...（当前 ${seatCount}/4，超时后自动中止）`)
      }
      await host.waitForTimeout(2000)
    }
    if (seatCount < 4) {
      await attemptScreenshot(scriptPages, testInfo, 'four-wait-human-timeout')
      throw new Error(`等待真人加入超时（房间 ${roomCode}，25 分钟内未满 4 席）`)
    }
    console.log('[FOUR] 真人已加入（4/4 席）。等待真人点击准备')

    // ── 等真人准备（房主「开始对局」启用 = 4/4 全员就绪）──
    const readyDeadline = Date.now() + 15 * 60_000
    const start = host.getByRole('button', { name: /开始对局/ })
    let lastReadyNotice = 0
    while (Date.now() < readyDeadline) {
      if (await start.isEnabled().catch(() => false)) break
      if (Date.now() - lastReadyNotice > 30_000) {
        lastReadyNotice = Date.now()
        console.log('[FOUR] 等待真人玩家点击「准备」...（房主开始按钮尚未启用）')
      }
      await host.waitForTimeout(2000)
    }
    await expect(start).toBeEnabled({ timeout: 30_000 })
    console.log('[FOUR] 4/4 全员已准备，房主 5 秒后开始对局（东风场·莲花麻将）')
    await host.waitForTimeout(5000)

    // ── 开局 ──
    await Promise.all(scriptPages.map(installOpeningSampler))
    const matchStartedAt = Date.now()
    const openingPromises = scriptPages.map((page, index) => waitForOpeningOrTableLoadError(
      page, index === 0 ? '房主' : `脚本客人${index}`,
    ))
    await start.click()
    try {
      await Promise.all(openingPromises)
    } catch (error) {
      await attemptScreenshot(scriptPages, testInfo, 'four-opening-fail')
      throw error
    }
    // 生产「托管」：auto=1 应已开启；未开启或按钮缺失时回退 DOM 自动点击（不保护精牌）。
    await host.waitForTimeout(1500)
    const trusteePages: Page[] = []
    for (let index = 0; index < scriptPages.length; index += 1) {
      const trusted = await ensureTrustedAutoPlay(scriptPages[index], `账号槽位 ${index + 1}`)
      if (trusted) continue
      await installAutoPlayer(scriptPages[index])
      trusteePages.push(scriptPages[index])
      issues.push({
        at: new Date().toISOString(), slot: index + 1, category: 'trustee-unavailable',
        message: '托管按钮缺失或未能开启，回退到 DOM 自动点击器（不保护精牌）',
      })
    }
    for (const page of scriptPages) {
      await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 150_000 }).toBeGreaterThanOrEqual(4)
    }
    await host.waitForTimeout(1500)

    // ── 主循环观测 ──
    const markers = ['东1局', '东2局', '东3局', '东4局']
    const observed = scriptPages.map(() => [] as string[])
    const timings: Array<{ hand: string; seconds: number; note?: string }> = []
    const revealVerified = new Set<string>()
    const continueClicked = new Map<string, boolean[]>()
    const lastSettlementSignatures = scriptPages.map(() => '')
    const logOffsets = consoleLogs.map((logs) => logs.length)
    let activeHand = ''
    let activeHandObservedAt = matchStartedAt
    let activeHandStartedAt = matchStartedAt
    let settledHand = ''
    let settlementStartedAt = 0
    let waitingForPreviousSettlementToClear = false
    let lastProgressAt = 0
    const deadline = matchStartedAt + 45 * 60_000

    while (Date.now() < deadline) {
      const labels = await Promise.all(scriptPages.map(readRoundLabel))
      const huds = await Promise.all(scriptPages.map(readHudSignals))
      const settlementVisible = await Promise.all(scriptPages.map((page) => (
        page.locator('.round-settlement').isVisible().catch(() => false)
      )))
      const continueVisible = await Promise.all(scriptPages.map((page) => (
        page.locator('.round-settlement .result-actions button').filter({ hasText: /^继续/ }).first()
          .isVisible().catch(() => false)
      )))
      for (let index = 0; index < settlementVisible.length; index += 1) {
        settlementVisible[index] ||= continueVisible[index]
      }
      const settlementTexts = await Promise.all(scriptPages.map((page, index) => (
        settlementVisible[index]
          ? page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => '')
          : Promise.resolve('')
      )))
      const finals = await Promise.all(scriptPages.map((page) => (
        page.locator('.final-backdrop').isVisible().catch(() => false)
      )))

      for (let index = 0; index < labels.length; index += 1) {
        for (const marker of markers) {
          if (labels[index].includes(marker) && !observed[index].includes(marker)) observed[index].push(marker)
        }
      }

      const anchorLabel = labels[0]
      if (anchorLabel && anchorLabel !== activeHand) {
        const first = !activeHand
        const previousHand = activeHand
        if (previousHand) {
          const duration = (settledHand === previousHand && settlementStartedAt > 0
            ? settlementStartedAt : Date.now()) - (activeHandStartedAt || activeHandObservedAt)
          const seconds = Math.round(duration / 1000)
          if (!timings.some((item) => item.hand === previousHand)) {
            timings.push({ hand: previousHand, seconds, note: seconds > 360 ? '超过6分钟' : undefined })
          }
          if (seconds > 360) {
            issues.push({
              at: new Date().toISOString(), slot: 0, category: 'hand-slow',
              message: `${previousHand} 用时 ${seconds}s（超过 6 分钟）`,
            })
          }
          if (seconds > 900) {
            await attemptScreenshot(scriptPages, testInfo, `four-${handToken(previousHand)}-deadlock`)
            throw new Error(`${previousHand} 超过 15 分钟未推进，判定为死锁`)
          }
        }
        activeHand = anchorLabel
        activeHandObservedAt = Date.now()
        const replaced = settlementTexts.some((text, index) => (
          settlementVisible[index] && roundToken(text) === roundToken(anchorLabel)
        ))
        waitingForPreviousSettlementToClear = !first && settlementVisible.some(Boolean) && !replaced
        activeHandStartedAt = first ? matchStartedAt : (waitingForPreviousSettlementToClear ? 0 : activeHandObservedAt)
        settledHand = ''
        settlementStartedAt = 0
        console.log(`[FOUR] 进入 ${anchorLabel}`)
      }
      if (waitingForPreviousSettlementToClear) {
        const replaced = settlementTexts.some((text, index) => (
          settlementVisible[index] && roundToken(text) === roundToken(activeHand)
        ))
        if (settlementVisible.every((visible) => !visible) || replaced) {
          waitingForPreviousSettlementToClear = false
          activeHandStartedAt = activeHandObservedAt
        }
      }

      const belongsToActive = settlementTexts.map((text, index) => (
        settlementVisible[index] && roundToken(text) === roundToken(activeHand)
      ))
      const matchesActive = settlementTexts.map((text, index) => (
        belongsToActive[index] && settlementSignature(text) !== lastSettlementSignatures[index]
      ))
      const token = handToken(activeHand)
      if (token && activeHandStartedAt > 0 && !waitingForPreviousSettlementToClear
        && matchesActive.some(Boolean) && settledHand !== activeHand) {
        settledHand = activeHand
        settlementStartedAt = Date.now()
        for (let index = 0; index < matchesActive.length; index += 1) {
          if (matchesActive[index]) lastSettlementSignatures[index] = settlementSignature(settlementTexts[index])
        }
        const seconds = Math.round((settlementStartedAt - activeHandStartedAt) / 1000)
        if (!timings.some((item) => item.hand === activeHand)) {
          timings.push({ hand: activeHand, seconds, note: seconds > 360 ? '超过6分钟' : undefined })
        }
        console.log(`[FOUR] ${activeHand} 到结算 ${seconds}s`)
        if (seconds > 360) {
          issues.push({
            at: new Date().toISOString(), slot: 0, category: 'hand-slow',
            message: `${activeHand} 到结算 ${seconds}s（超过 6 分钟）`,
          })
        }
      }

      if (token && !revealVerified.has(token) && settledHand === activeHand) {
        const reveals = huds.map((hud) => Boolean(hud
          && hud.revealHands
          && hud.revealedFaceCounts.length === 4
          && hud.revealedFaceCounts.every((count) => count > 0)))
        if (reveals.every(Boolean)) {
          revealVerified.add(token)
          console.log(`[FOUR] ${activeHand} 脚本三端四家真实亮牌已确认`)
        } else if (settlementStartedAt > 0 && Date.now() - settlementStartedAt > 120_000) {
          if (!issues.some((item) => item.category === 'reveal-missing' && item.message.includes(token))) {
            issues.push({
              at: new Date().toISOString(), slot: 0, category: 'reveal-missing',
              message: `${activeHand} 结算后 120 秒脚本端仍未确认四家真实亮牌`,
            })
          }
        }
      }

      if (token && revealVerified.has(token) && settledHand === activeHand) {
        const clicked = continueClicked.get(token) ?? [false, false, false]
        const results = await Promise.all(scriptPages.map((page, index) => (
          belongsToActive[index] && !clicked[index] ? clickContinueIfAvailable(page) : Promise.resolve(false)
        )))
        for (let index = 0; index < results.length; index += 1) {
          if (results[index]) {
            clicked[index] = true
            console.log(`[FOUR] ${activeHand} 账号槽位 ${index + 1} 已点击确认（等待真人确认）`)
          }
        }
        continueClicked.set(token, clicked)
        if (clicked.every(Boolean) && Date.now() - (settlementStartedAt || Date.now()) > 120_000) {
          if (!issues.some((item) => item.category === 'human-confirm-slow' && item.message.includes(token))) {
            issues.push({
              at: new Date().toISOString(), slot: 0, category: 'human-confirm-slow',
              message: `${activeHand} 脚本三端已确认，120 秒后仍未进入下一局（等待真人确认）`,
            })
          }
        }
        if (clicked.every(Boolean) && Date.now() - (settlementStartedAt || Date.now()) > 600_000) {
          await attemptScreenshot(scriptPages, testInfo, `four-${token}-confirm-deadlock`)
          throw new Error(`${activeHand} 脚本三端确认后 10 分钟仍未推进（等待真人确认）`)
        }
      }

      if (finals.every(Boolean)) break

      if (token && activeHandStartedAt > 0 && settledHand !== activeHand
        && Date.now() - activeHandStartedAt > 900_000) {
        await attemptScreenshot(scriptPages, testInfo, `four-${token}-no-settlement`)
        throw new Error(`${activeHand} 超过 15 分钟未出现结算，判定为死锁`)
      }
      if (Date.now() - lastProgressAt > 30_000) {
        lastProgressAt = Date.now()
        console.log(`[FOUR][${Math.round((Date.now() - matchStartedAt) / 1000)}s] ${labels.join(' | ')}`)
      }
      await scriptPages[0].waitForTimeout(500)
    }

    expect(observed[0], '房主端轮次不完整').toEqual(markers)
    expect(observed[1], '脚本客人1端轮次不完整').toEqual(markers)
    expect(observed[2], '脚本客人2端轮次不完整').toEqual(markers)
    for (const page of scriptPages) {
      await expect(page.locator('.final-backdrop')).toBeVisible({ timeout: 120_000 })
      await expect(page.getByText('最终排名')).toBeVisible()
    }
    const finalStandings = await Promise.all(scriptPages.map(readFinalStandings))
    for (let index = 0; index < finalStandings.length; index += 1) {
      expect(finalStandings[index], `最终排名（页面 ${index + 1}）`).toHaveLength(4)
      for (const entry of finalStandings[index]) {
        expect(entry.name).not.toBe('')
        expect(Number.isInteger(entry.rank) && entry.rank >= 1 && entry.rank <= 4).toBe(true)
        expect(Number.isFinite(entry.score)).toBe(true)
      }
    }
    expect(finalStandings[1]).toEqual(finalStandings[0])
    expect(finalStandings[2]).toEqual(finalStandings[0])

    const finalOpeningHistories = await Promise.all(scriptPages.map((page) => openingHistory(page, true)))
    const hands = [...new Set(timings.map((item) => item.hand))]
    for (let index = 0; index < finalOpeningHistories.length; index += 1) {
      for (const hand of hands) {
        const stages = finalOpeningHistories[index]
          .filter((sample) => sample.hand === hand)
          .map((sample) => sample.stage)
        for (const required of ['start', 'dice', 'flip', 'deal']) {
          expect(stages, `页面 ${index + 1} ${hand} 缺少 ${required} 开局阶段`).toContain(required)
        }
      }
    }

    await testInfo.attach('four-players-result', {
      body: JSON.stringify({
        roomCode, hostSlot: HOST_SLOT + 1,
        timings, finalStandings,
        issues,
        revealedHands: [...revealVerified],
        openingHistories: finalOpeningHistories,
        elapsedSeconds: Math.round((Date.now() - matchStartedAt) / 1000),
        pageErrors,
      }, null, 2),
      contentType: 'application/json',
    })
    console.log(`[FOUR] 东风场完成，房间 ${roomCode}，用时 ${Math.round((Date.now() - matchStartedAt) / 1000)}s`)
    console.log(`[FOUR] 最终分数：${finalStandings[0].map((entry) => `${entry.rank}位 ${entry.name} ${entry.score}`).join('；')}`)
    console.log(`[FOUR] 观察问题数：${issues.length}`)
    if (issues.length > 0) {
      for (const issue of issues.slice(0, 80)) {
        console.log(`[FOUR][问题][${issue.category}] ${issue.message}`)
      }
    }
    return { roomCode, timings, finalStandings, issues }
  } catch (error) {
    if (activePages) {
      await attemptScreenshot(activePages, testInfo, 'four-failure')
      await testInfo.attach('four-failure-evidence', {
        body: JSON.stringify({
          error: String(error),
          issues,
          pages: await Promise.all(activePages.map(async (page) => ({
            round: await readRoundLabel(page),
            hud: await readHudSignals(page),
            load: await readTableLoadState(page),
            settlement: await page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => ''),
            final: await page.locator('.final-backdrop').isVisible().catch(() => false),
            openingStages: await openingHistory(page),
          }))),
        }, null, 2),
        contentType: 'application/json',
      })
    }
    throw error
  } finally {
    await closeAccountBrowsers(triple)
  }
})
