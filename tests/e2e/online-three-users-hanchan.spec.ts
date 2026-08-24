// 三真实账号 · 半庄场 · 莲花麻将：凭据与 URL 只在运行时从 tmp/online_test 读取，绝不写入日志/附件。
//
// 流程：读取 tmp/online_test 中的 3 个用户 → 随机决定房主（建房者即房主）→
// 房主创建房间（场次=半庄场，玩法=莲花麻将 lotus-legacy）→ 其余两人用房间码加入 →
// 3 真人全员准备（第 4 席由引擎 AI 补位）→ 开局 → 自动出牌/过牌/胡 →
// 打完东1-东4 + 南1-南4 共 8 手 → 三端最终排名一致。
import { readFileSync, appendFileSync } from 'node:fs'
import { chromium, expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

interface Account { email: string; password: string }
interface OnlineConfig { url: string; accounts: Account[] }
interface FinalStanding { rank: number; name: string; score: number }
interface PageErrorRecord { at: number; name: string; message: string; stack: string }
interface OpeningStageSample { at: number; hand: string; stage: string; wallCount: number; wallHeadDrawn: number }

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

// ── 随机房主 ──────────────────────────────────────────────
// 默认完全随机；ONLINE_HOST_SLOT=1/2/3 可固定某个账号槽位做复现（槽位按 tmp/online_test 顺序）。
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

// 可为真实账号注入浏览器级代理（可选，未设置保持生产默认直连）：
// ONLINE_PROXY_SERVERS=http://proxy-a.example:3128,socks5://proxy-b.example:1080,socks5://proxy-c.example:1080
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
  // VibeHub OAuth 在同一 Chromium 进程内可能串行占用浏览器级 connect 状态；
  // 三个真实账号分别使用独立进程，等价于三台真实用户设备。
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
  // manualContinue=1 关闭生产默认的 10 秒自动确认，脚本在四家亮牌验证后再点「继续」。
  params.set('manualContinue', '1')
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
    // OAuth 弹窗自身的成功/错误页面都不是最终事实；只有游戏页进入大厅才算成功。
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
      // 授权按钮会先关闭弹窗，再通过 postMessage/SDK 回调更新游戏页。弹窗关闭不是失败事实；
      // 等到大厅真实出现，或错误和可重试登录按钮同时出现，才判定本会话结果。
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

/** 正常路径必须一次加入即同步 roster；不允许用离开/重入掩盖恢复异常。 */
async function waitForRoomReady(pages: Page[], roomCode: string) {
  try {
    const handles = await Promise.all(pages.map((page) => page.waitForFunction(() => {
      const ready = [...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => (
        button.textContent?.trim() === '准备 / 取消准备'
          && button.getClientRects().length > 0
          && getComputedStyle(button).visibility !== 'hidden'
          && getComputedStyle(button).display !== 'none'
      ))
      return ready && document.querySelectorAll('.room-seat').length >= 3
    }, undefined, { timeout: 90_000, polling: 100 })))
    await Promise.all(handles.map((handle) => handle.dispose()))
    return
  } catch {
    // 失败诊断在各自页面内原子读取。
  }
  const states = await Promise.all(pages.map((page) => page.evaluate(() => ({
    ready: [...document.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.textContent?.trim() === '准备 / 取消准备'),
    seats: document.querySelectorAll('.room-seat').length,
  })).catch(() => ({ ready: false, seats: 0 }))))
  throw new Error(`正常加入后 90 秒 roster 仍未同步（room=${roomCode} states=${JSON.stringify(states)}）；本轮禁止离开重入兜底`)
}

interface AutoPlayerEvent { at: number; type: 'hu-click' | 'pass-click' | 'discard-click' }

async function installAutoPlayer(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as {
      __hanchanAuto?: number
      __hanchanAutoEvents?: AutoPlayerEvent[]
    }
    if (state.__hanchanAuto) return
    state.__hanchanAutoEvents = []
    state.__hanchanAuto = window.setInterval(() => {
      const actionBar = document.querySelector('.action-bar')
      if (actionBar) {
        const hu = actionBar.querySelector<HTMLButtonElement>('.action.hu')
        if (hu) {
          state.__hanchanAutoEvents?.push({ at: Date.now(), type: 'hu-click' })
          hu.click()
          return
        }
        const pass = actionBar.querySelector<HTMLButtonElement>('.action.pass')
        if (pass) {
          state.__hanchanAutoEvents?.push({ at: Date.now(), type: 'pass-click' })
          pass.click()
          return
        }
      }
      const tile = document.querySelector<HTMLElement>('.hand-rack.playable .hand-tile-slot .mahjong-tile')
      if (tile) {
        state.__hanchanAutoEvents?.push({ at: Date.now(), type: 'discard-click' })
        tile.click()
      }
    }, 120)
  })
}

async function takeAutoPlayerEvents(page: Page) {
  return page.evaluate(() => {
    const state = window as unknown as { __hanchanAutoEvents?: AutoPlayerEvent[] }
    return state.__hanchanAutoEvents?.splice(0) ?? []
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
      __hanchanOpeningStages?: OpeningStageSample[]
      __hanchanOpeningSampler?: number
    }
    if (target.__hanchanOpeningSampler) window.clearInterval(target.__hanchanOpeningSampler)
    target.__hanchanOpeningStages = []
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
        target.__hanchanOpeningStages?.push({ at: Date.now(), hand, stage, wallCount, wallHeadDrawn })
      }
    }
    target.__hanchanOpeningSampler = window.setInterval(sample, 100)
  })
}

async function openingHistory(page: Page, stop = false): Promise<OpeningStageSample[]> {
  return page.evaluate((shouldStop) => {
    const target = window as unknown as {
      __hanchanOpeningStages?: OpeningStageSample[]
      __hanchanOpeningSampler?: number
    }
    if (shouldStop && target.__hanchanOpeningSampler) window.clearInterval(target.__hanchanOpeningSampler)
    return target.__hanchanOpeningStages ?? []
  }, stop)
}

async function readFinalStandings(page: Page): Promise<FinalStanding[]> {
  return page.locator('.final-rankings article').evaluateAll((articles) => articles.map((article) => ({
    rank: Number(article.querySelector('.final-rank b')?.textContent?.trim() ?? Number.NaN),
    name: article.querySelector('.final-name strong')?.textContent?.trim() ?? '',
    score: Number(article.querySelector('em')?.textContent?.trim() ?? Number.NaN),
  })))
}

async function attachTripleScreenshots(pages: Page[], testInfo: TestInfo, name: string) {
  try {
    for (let index = 0; index < pages.length; index += 1) {
      const body = await pages[index].screenshot({ timeout: 8000 })
      await testInfo.attach(`${name}-slot-${index + 1}`, { body, contentType: 'image/png' })
      await pages[index].waitForTimeout(100)
    }
  } catch (error) {
    console.log(`[spec] 截图 ${name} 超时/失败，跳过取证（不影响业务判定）: ${String(error).slice(0, 160)}`)
  }
}

async function failWithEvidence(
  pages: Page[],
  testInfo: TestInfo,
  consoleLogs: string[][],
  name: string,
  message: string,
): Promise<never> {
  await attachTripleScreenshots(pages, testInfo, name)
  const evidence = await Promise.all(pages.map(async (page) => ({
    round: await readRoundLabel(page),
    hud: await readHudSignals(page),
    load: await readTableLoadState(page),
    settlement: await page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => ''),
    final: await page.locator('.final-backdrop').isVisible().catch(() => false),
    openingStages: await openingHistory(page),
  })))
  await testInfo.attach(`${name}-state`, {
    body: JSON.stringify({ message, evidence, consoleLogs }, null, 2),
    contentType: 'application/json',
  })
  throw new Error(`${message}\nstates=${JSON.stringify(evidence)}\nlogs=${JSON.stringify(consoleLogs.map((x) => x.slice(-30)))}`)
}

const fatalOnlineSignal = /先释放旧连接再重进|自动重进失败|尝试重新加入房间|房主连接中断|恢复牌局|已验证重进握手|大厅验证的新 peer 已恢复原座位|丢弃.*(?:旧|权威|代次)|旧权威|AI 代打|AI 接管|非法状态快照|\[wall-regress\]/i

async function clickContinueIfAvailable(page: Page) {
  const button = page.locator('.round-settlement .result-actions button').filter({ hasText: /^继续/ }).first()
  if (!await button.isVisible().catch(() => false)) return false
  if (!await button.isEnabled().catch(() => false)) return false
  await button.evaluate((element: HTMLButtonElement) => element.click()).catch(() => {})
  return true
}

async function runHanchan(options: {
  host: Page
  guests: Page[]
  consoleLogs: string[][]
  testInfo: TestInfo
}) {
  const { host, guests, consoleLogs, testInfo } = options
  const pages = [host, ...guests]
  const suffix = Date.now().toString(36).slice(-5)

  // ── 建房（房主 = 随机选中的用户）──
  await enterOnlineLobby(host, `线上房主-${suffix}`, 'host')
  await host.getByRole('button', { name: '创建房间', exact: true }).click()
  // 场次 → 半庄场
  await host.locator('.lobby-dialog .game-settings button', { hasText: '场次' }).click()
  await host.getByRole('button', { name: /半庄场/ }).click()
  await host.getByRole('button', { name: '确定', exact: true }).click()
  // 玩法 → 莲花麻将（lotus-legacy，翻精癞子）
  await host.locator('.lobby-dialog .game-settings button', { hasText: '玩法' }).click()
  await host.getByRole('button', { name: /莲花麻将/ }).click()
  await host.getByRole('button', { name: '确定', exact: true }).click()
  await host.getByRole('button', { name: '确认创建', exact: true }).click()
  await acceptDisclaimerIfShown(host)

  await host.locator('.room-code strong').waitFor({ timeout: 40_000 })
  const roomCode = (await host.locator('.room-code strong').innerText()).trim()
  expect(roomCode).toMatch(/^[A-Z0-9]{6}$/)
  console.log(`[HANCHAN] 房间 ${roomCode} 已创建（房主为随机账号槽位 ${HOST_SLOT + 1}）`)

  // ── 两人加入 ──
  for (let index = 0; index < guests.length; index += 1) {
    const guest = guests[index]
    await enterOnlineLobby(guest, `线上客人${index + 1}-${suffix}`, 'client')
    await guest.getByRole('button', { name: '加入房间', exact: true }).click()
    await guest.getByPlaceholder('输入 6 位房间码').fill(roomCode)
    await guest.getByRole('button', { name: '确认加入' }).click()
    await acceptDisclaimerIfShown(guest)
  }

  // ── 大厅就绪：3 真人 + 1 AI ──
  try {
    await waitForRoomReady(pages, roomCode)
  } catch (error) {
    await failWithEvidence(pages, testInfo, consoleLogs, 'hanchan-roster-sync-failure', String(error))
  }
  const occupiedSeats = await Promise.all(pages.map((page) => page.locator('.room-seat.occupied').count()))
  expect(occupiedSeats, '半庄场必须只有 3 个真人，空余 1 席由 AI 补位').toEqual([3, 3, 3])
  await Promise.all(pages.map(installOpeningSampler))

  const start = host.getByRole('button', { name: /开始对局/ })
  if (!await start.isEnabled().catch(() => false)) {
    await Promise.all(pages.map((page) => page.getByRole('button', { name: '准备 / 取消准备' }).click()))
  }
  await expect(start).toBeEnabled({ timeout: 60_000 })
  const matchStartedAt = Date.now()
  // 先创建开局等待 Promise（开始对局后才会出现开局动画），再点击开始并等待。
  const openingPromises = pages.map((page, index) => waitForOpeningOrTableLoadError(
    page, index === 0 ? '房主' : `客人${index}`,
  ))
  await start.click()
  try {
    await Promise.all(openingPromises)
  } catch (error) {
    await failWithEvidence(pages, testInfo, consoleLogs, 'hanchan-opening-fail', String(error))
  }
  await Promise.all(pages.map(installAutoPlayer))
  for (const page of pages) {
    await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 150_000 }).toBeGreaterThanOrEqual(4)
    await expect(page.locator('.player-seat')).toHaveCount(3)
  }
  await host.waitForTimeout(1500)

  // ── 主循环：打完东1-东4 + 南1-南4 ──
  const markers = ['东1局', '东2局', '东3局', '东4局', '南1局', '南2局', '南3局', '南4局']
  const observed = [[], [], []] as [string[], string[], string[]]
  const timings: Array<{ hand: string; seconds: number }> = []
  const confirmedAt = new Map<string, number[]>()
  const revealVerified = new Set<string>()
  const continueClicked = new Map<string, boolean[]>()
  const lastSettlementSignatures = ['', '', '']
  const logOffsets = consoleLogs.map((logs) => logs.length)
  let activeHand = ''
  let activeHandObservedAt = matchStartedAt
  let activeHandStartedAt = matchStartedAt
  let settledHand = ''
  let settlementStartedAt = 0
  let waitingForPreviousSettlementToClear = false
  let lastProgressAt = 0
  const deadline = matchStartedAt + 5_400_000

  while (Date.now() < deadline) {
    for (let index = 0; index < consoleLogs.length; index += 1) {
      const fatal = consoleLogs[index].slice(logOffsets[index]).find((line) => fatalOnlineSignal.test(line))
      if (fatal) {
        await failWithEvidence(pages, testInfo, consoleLogs,
          `hanchan-forbidden-recovery-${index}`,
          `半庄场账号槽位 ${index + 1} 出现禁止的恢复/重连/旧代次/AI接管信号：${fatal}`)
      }
    }

    const labels = await Promise.all(pages.map(readRoundLabel))
    const huds = await Promise.all(pages.map(readHudSignals))
    const settlementVisible = await Promise.all(pages.map((page) => (
      page.locator('.round-settlement').isVisible().catch(() => false)
    )))
    const continueVisible = await Promise.all(pages.map((page) => (
      page.locator('.round-settlement .result-actions button').filter({ hasText: /^继续/ }).first()
        .isVisible().catch(() => false)
    )))
    for (let index = 0; index < settlementVisible.length; index += 1) {
      settlementVisible[index] ||= continueVisible[index]
    }
    const settlementTexts = await Promise.all(pages.map((page, index) => (
      settlementVisible[index]
        ? page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => '')
        : Promise.resolve('')
    )))
    const finals = await Promise.all(pages.map((page) => (
      page.locator('.final-backdrop').isVisible().catch(() => false)
    )))

    // 收集观察到的局号标记
    for (let index = 0; index < labels.length; index += 1) {
      for (const marker of markers) {
        if (labels[index].includes(marker) && !observed[index].includes(marker)) observed[index].push(marker)
      }
    }

    // 局号切换（以房主端为锚点）
    const anchorLabel = labels[0]
    if (anchorLabel && anchorLabel !== activeHand) {
      const first = !activeHand
      const previousHand = activeHand
      if (previousHand) {
        const duration = (settledHand === previousHand && settlementStartedAt > 0
          ? settlementStartedAt : Date.now()) - (activeHandStartedAt || activeHandObservedAt)
        if (!timings.some((item) => item.hand === previousHand)) {
          timings.push({ hand: previousHand, seconds: Math.round(duration / 1000) })
        }
        if (duration > 360_000) {
          throw await failWithEvidence(pages, testInfo, consoleLogs,
            `hanchan-${handToken(previousHand)}-too-slow`,
            `半庄场 ${previousHand} 到切局超过 6 分钟（${Math.round(duration / 1000)}s）`)
        }
      }
      activeHand = anchorLabel
      activeHandObservedAt = Date.now()
      // 上一局结算层可能尚未退场：等它清掉（或被新局结算替换）后再开始计时。
      const replaced = settlementTexts.some((text, index) => (
        settlementVisible[index] && roundToken(text) === roundToken(anchorLabel)
      ))
      waitingForPreviousSettlementToClear = !first && settlementVisible.some(Boolean) && !replaced
      activeHandStartedAt = first ? matchStartedAt : (waitingForPreviousSettlementToClear ? 0 : activeHandObservedAt)
      settledHand = ''
      settlementStartedAt = 0
      console.log(`[HANCHAN] 进入 ${anchorLabel}`)
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

    // 结算检测：任一端出现当前局结算即计时
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
        timings.push({ hand: activeHand, seconds })
      }
      console.log(`[HANCHAN] ${activeHand} 到结算 ${seconds}s`)
      if (seconds > 360) {
        await failWithEvidence(pages, testInfo, consoleLogs,
          `hanchan-${token}-over-6min`, `半庄场 ${activeHand} 到结算超过 6 分钟（${seconds}s）`)
      }
    }

    // 四家真实亮牌验证（只读 HUD 原子信号，不记录任何牌面值）
    if (token && !revealVerified.has(token) && settledHand === activeHand) {
      const reveals = huds.map((hud) => Boolean(hud
        && hud.revealHands
        && hud.revealedFaceCounts.length === 4
        && hud.revealedFaceCounts.every((count) => count > 0)))
      if (reveals.every(Boolean)) {
        revealVerified.add(token)
        console.log(`[HANCHAN] ${activeHand} 三端四家真实亮牌已确认`)
      }
    }

    // 亮牌验证通过后，三端点击「继续」
    if (token && revealVerified.has(token) && settledHand === activeHand) {
      const clicked = continueClicked.get(token) ?? [false, false, false]
      const results = await Promise.all(pages.map((page, index) => (
        belongsToActive[index] && !clicked[index] ? clickContinueIfAvailable(page) : Promise.resolve(false)
      )))
      for (let index = 0; index < results.length; index += 1) {
        if (results[index]) {
          clicked[index] = true
          const confirmed = confirmedAt.get(token) ?? [0, 0, 0]
          confirmed[index] ||= Date.now()
          confirmedAt.set(token, confirmed)
          console.log(`[HANCHAN] ${activeHand} 账号槽位 ${index + 1} 已点击确认`)
        }
      }
      continueClicked.set(token, clicked)
    }

    // 终局
    if (finals.every(Boolean)) break

    // 看门狗：结算后 180 秒未推进
    if (settledHand === activeHand && settlementStartedAt > 0
      && Date.now() - settlementStartedAt > 180_000) {
      await failWithEvidence(pages, testInfo, consoleLogs,
        `hanchan-${token}-stuck-after-settlement`,
        `半庄场 ${activeHand} 结算后 180 秒未推进`)
    }
    // 看门狗：当前手 360 秒未结算
    if (token && activeHandStartedAt > 0 && settledHand !== activeHand
      && Date.now() - activeHandStartedAt > 360_000) {
      await failWithEvidence(pages, testInfo, consoleLogs,
        `hanchan-${token}-no-settlement`,
        `半庄场 ${activeHand} 超时 6 分钟仍未出现结算`)
    }
    if (Date.now() - lastProgressAt > 30_000) {
      lastProgressAt = Date.now()
      console.log(`[HANCHAN][${Math.round((Date.now() - matchStartedAt) / 1000)}s] ${labels.join(' | ')}`)
    }
    await pages[0].waitForTimeout(500)
  }

  expect(observed[0], '半庄场房主端轮次不完整').toEqual(markers)
  expect(observed[1], '半庄场客人1端轮次不完整').toEqual(markers)
  expect(observed[2], '半庄场客人2端轮次不完整').toEqual(markers)
  for (const page of pages) {
    await expect(page.locator('.final-backdrop')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('最终排名')).toBeVisible()
  }
  const finalStandings = await Promise.all(pages.map(readFinalStandings))
  for (let index = 0; index < finalStandings.length; index += 1) {
    expect(finalStandings[index], `半庄场页面 ${index + 1} 最终排名必须显示四家姓名、名次和分数`)
      .toHaveLength(4)
    for (const entry of finalStandings[index]) {
      expect(entry.name, `半庄场页面 ${index + 1} 最终排名存在空姓名`).not.toBe('')
      expect(Number.isInteger(entry.rank) && entry.rank >= 1 && entry.rank <= 4,
        `半庄场页面 ${index + 1} 最终名次非法`).toBe(true)
      expect(Number.isFinite(entry.score), `半庄场页面 ${index + 1} 最终分数不可读`).toBe(true)
    }
  }
  expect(finalStandings[1], '半庄场三端最终排名与分数不一致').toEqual(finalStandings[0])
  expect(finalStandings[2], '半庄场三端最终排名与分数不一致').toEqual(finalStandings[0])

  const finalOpeningHistories = await Promise.all(pages.map((page) => openingHistory(page, true)))
  const hands = [...new Set(timings.map((item) => item.hand))]
  for (let index = 0; index < finalOpeningHistories.length; index += 1) {
    for (const hand of hands) {
      const stages = finalOpeningHistories[index]
        .filter((sample) => sample.hand === hand)
        .map((sample) => sample.stage)
      for (const required of ['start', 'dice', 'flip', 'deal']) {
        expect(stages, `半庄场页面 ${index + 1} ${hand} 缺少 ${required} 开局阶段`).toContain(required)
      }
    }
  }

  await testInfo.attach('hanchan-result', {
    body: JSON.stringify({
      roomCode,
      hostSlot: HOST_SLOT + 1,
      timings,
      openingHistories: finalOpeningHistories,
      finalStandings,
      revealedHands: [...revealVerified],
      autoEvents: await Promise.all(pages.map(takeAutoPlayerEvents)),
      elapsedSeconds: Math.round((Date.now() - matchStartedAt) / 1000),
    }, null, 2),
    contentType: 'application/json',
  })
  console.log(`[HANCHAN] 半庄场完成，房间 ${roomCode}，用时 ${Math.round((Date.now() - matchStartedAt) / 1000)}s`)
  console.log(`[HANCHAN] 最终分数：${finalStandings[0].map((entry) => `${entry.rank}位 ${entry.name} ${entry.score}`).join('；')}`)
}

test('三个线上账号随机房主完成一场莲花麻将半庄场，每手不超过6分钟', async ({}, testInfo) => {
  const triple = await launchAccountBrowsers()
  let activePages: Page[] | null = null
  let capturedLogs: string[][] = [[], [], []]
  let capturedPageErrors: PageErrorRecord[][] = [[], [], []]
  try {
    console.log(`[HANCHAN] 随机房主 = tmp/online_test 账号槽位 ${HOST_SLOT + 1}；客人槽位 ${GUEST_SLOTS.map((slot) => slot + 1).join('、')}`)
    // 游戏授权令牌位于当前标签页的 sessionStorage；必须复用授权返回的页面。
    const pages = await Promise.all(ONLINE.accounts.map((account, index) => (
      authenticate(triple.contexts[index], account)
    )))
    activePages = pages
    const logs = pages.map(() => [] as string[])
    capturedLogs = logs
    const errors = pages.map(() => [] as PageErrorRecord[])
    capturedPageErrors = errors
    pages.forEach((page, index) => {
      const logFile = `tmp/online-three-users-hanchan-console-${index + 1}.log`
      appendFileSync(logFile, `\n===== 会话开始 ${new Date().toISOString()} =====\n`)
      page.on('pageerror', (error) => errors[index].push({
        at: Date.now(),
        name: error.name,
        message: error.message,
        stack: error.stack ?? '',
      }))
      page.on('console', (message) => {
        const line = message.text()
        appendFileSync(logFile, `${new Date().toISOString()} [${message.type()}] ${line}\n`)
        if (/\[host\]|\[client\]|\[diag\]|\[transport\]|心跳|主动重建|error|warn|丢弃|重进|洗牌|快照|continue|shuffle|AI 代打|wall-regress/i.test(line)) {
          logs[index].push(line)
        }
      })
    })
    const host = pages[HOST_SLOT]
    const guests = GUEST_SLOTS.map((slot) => pages[slot])
    await runHanchan({ host, guests, consoleLogs: logs, testInfo })
    for (let index = 0; index < errors.length; index += 1) {
      const appErrors = errors[index].filter((error) => !(
        error.message === 'Failed to fetch'
        && /https:\/\/vibe\.lumigrav\.space\/sdk\/v3\/vibehub\.js(?:[:?]|$)/.test(error.stack)
      ))
      await testInfo.attach(`hanchan-page-errors-${index}`, {
        body: JSON.stringify({ applicationErrors: appErrors }, null, 2),
        contentType: 'application/json',
      })
      expect(appErrors, `账号槽位 ${index + 1} 出现未捕获应用异常`).toEqual([])
    }
  } catch (error) {
    if (activePages) {
      await attachTripleScreenshots(activePages, testInfo, 'hanchan-failure')
      await testInfo.attach('hanchan-failure-evidence', {
        body: JSON.stringify({
          error: String(error),
          logs: capturedLogs,
          pageErrors: capturedPageErrors,
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
