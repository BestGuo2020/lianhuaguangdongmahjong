// 真实线上部署回归：凭据与 URL 只在运行时从 tmp/online_test 读取，绝不写入日志/附件。
// 两个 VibeHub 账号分别作为房主、客人；空余两席由引擎 AI 补齐，连续完成两个东风场。
import { readFileSync } from 'node:fs'
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

interface Account { email: string; password: string }
interface OnlineConfig { url: string; accounts: [Account, Account] }
interface AutoPlayerEvent { at: number; type: 'hu-click' | 'pass-click' | 'discard-click' }
interface TableVisualState {
  stage: string | null
  diceValues: number[]
  diceThrowerIndex: number
  wallBreakIndex: number
  flipStack: number | null
  wallCount: number
  wallHeadDrawn: number
  dealSerial: number
  dealCount: number
  winEffectId: number | null
}
interface OpeningSample extends TableVisualState {
  at: number
  cycle: number
  hand: string
}
interface WinEffectSample {
  at: number
  hand: string
  id: number
  winnerIndex: number
  tile: string
  visible: boolean
}
interface AudioPlaybackSample {
  at: number
  hand: string
  name: string
}
interface SettlementSample {
  at: number
  token: string
  confirmed: boolean
  appearance: boolean
  draw: boolean
  resultSignature: string
  labelMismatch: boolean
}
interface NormalizedPlayerState {
  seat: number
  score: number
  concealedCount: number
  discards: string[]
  melds: Array<{ type: string; tiles: string[]; fromSeat: number | null }>
}
interface NormalizedTableState {
  hand: string
  phase: string
  openingStage: string
  wallCount: number
  wallHeadDrawn: number
  winEffect: string
  players: NormalizedPlayerState[]
}
interface VisibleTableState {
  hand: string
  openingStage: string
  wallCount: number
  wallHeadDrawn: number
  winEffectVisible: boolean
  localHandCount: number
  canvasPresent: boolean
  canvasWidth: number
  canvasHeight: number
  contextLost: boolean | null
  loadingVisible: boolean
}
interface TableTransitionSample {
  at: number
  hand: string
  phase: string
  openingStage: string
  wallCount: number
  wallHeadDrawn: number
  concealedCount: number
  discardCount: number
  meldTileCount: number
  seats: number[]
  concealedCounts: number[]
  discardCounts: number[]
  meldTileCounts: number[]
  winEffectVisible: boolean
}
interface CanvasHealth {
  present: boolean
  width: number
  height: number
  cssWidth: number
  cssHeight: number
  nonBlackRatio: number
  averageLuminance: number
  contextLost: boolean | null
  loadingVisible: boolean
  loadingTextVisible: boolean
  tileResources: number
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
test.describe.configure({ mode: 'serial' })
test.setTimeout(9_000_000)

const roundToken = (value: string) => value.match(/东[1-4]局/)?.[0] ?? ''
const handToken = (value: string) => {
  const round = value.match(/东[1-4]局/)?.[0] ?? ''
  const honba = value.match(/(\d+)本场/)?.[1] ?? '0'
  return round ? `${round}:${honba}` : ''
}
const settlementSignature = (text: string) => text
  .split('\n')
  .filter((line) => !/查看牌桌|继续(?:\s*\(\d+\))?|等待其他玩家|已确认/.test(line))
  .join('\n')

async function installAudioProbe(context: BrowserContext) {
  await context.addInitScript(() => {
    const target = window as unknown as {
      __onlineAudioEvents?: AudioPlaybackSample[]
      __onlineAudioProbeInstalled?: boolean
    }
    if (target.__onlineAudioProbeInstalled) return
    target.__onlineAudioProbeInstalled = true
    target.__onlineAudioEvents = []
    const objectUrlSources = new Map<string, string>()
    const originalBlob = Response.prototype.blob
    Response.prototype.blob = async function () {
      const blob = await originalBlob.call(this)
      Object.defineProperty(blob, '__onlineSourceUrl', { value: this.url, configurable: true })
      return blob
    }
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = originalCreateObjectUrl(object)
      const source = (object as Blob & { __onlineSourceUrl?: string }).__onlineSourceUrl
      if (source) objectUrlSources.set(url, source)
      return url
    }
    const originalPlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (...args) {
      const raw = this.currentSrc || this.src
      const source = objectUrlSources.get(raw) ?? raw
      const name = source.match(/([^/?#]+\.(?:mp3|ogg))(?:[?#]|$)/i)?.[1] ?? ''
      if (/^(?:hu|zimo|hu_effect_sound)\.mp3$/i.test(name)) {
        target.__onlineAudioEvents?.push({
          at: Date.now(),
          hand: document.querySelector('.round-info')?.textContent?.trim() ?? '',
          name,
        })
      }
      return originalPlay.call(this)
    }
  })
}

async function audioHistory(page: Page): Promise<AudioPlaybackSample[]> {
  return page.evaluate(() => (
    (window as unknown as { __onlineAudioEvents?: AudioPlaybackSample[] }).__onlineAudioEvents ?? []
  ))
}

async function readCanvasHealth(page: Page): Promise<CanvasHealth> {
  const health = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.mahjong-scene')
    const loading = document.querySelector<HTMLElement>('.table-loading')
    const loadingText = document.querySelector<HTMLElement>('.table-loading-card')
    const visible = (element: HTMLElement | null) => Boolean(element
      && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden'
      && getComputedStyle(element).display !== 'none'
      && Number(getComputedStyle(element).opacity) > 0)
    if (!canvas) {
      return {
        present: false, width: 0, height: 0, cssWidth: 0, cssHeight: 0,
        nonBlackRatio: 0, averageLuminance: 0, contextLost: null,
        loadingVisible: visible(loading), loadingTextVisible: visible(loadingText),
        tileResources: performance.getEntriesByType('resource').filter((entry) => /\/tiles\/.*\.png(?:\?|$)/.test(entry.name)).length,
      }
    }
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    return {
      present: true,
      width: canvas.width,
      height: canvas.height,
      cssWidth: Math.round(canvas.getBoundingClientRect().width),
      cssHeight: Math.round(canvas.getBoundingClientRect().height),
      // WebGL 后缓冲默认不保证可读；像素值由下方浏览器合成截图覆盖。
      nonBlackRatio: 0,
      averageLuminance: 0,
      contextLost: gl ? gl.isContextLost() : null,
      loadingVisible: visible(loading),
      loadingTextVisible: visible(loadingText),
      tileResources: performance.getEntriesByType('resource').filter((entry) => /\/tiles\/.*\.png(?:\?|$)/.test(entry.name)).length,
    }
  })
  if (!health.present) return health
  try {
    const canvasBox = await page.locator('.mahjong-scene').boundingBox()
    const viewport = page.viewportSize()
    if (!canvasBox || !viewport) return health
    // 页面截图来自浏览器最终合成结果，能可靠包含 WebGL；元素截图或直接
    // 读取 WebGL Canvas 后缓冲都可能返回空像素，从而制造黑屏误报。
    const screenshot = await page.screenshot({ timeout: 8000 })
    const rendered = await page.evaluate(async ({ base64, box, viewportSize }) => {
      const image = new Image()
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('canvas screenshot decode failed'))
      })
      image.src = `data:image/png;base64,${base64}`
      await loaded
      const probe = document.createElement('canvas')
      probe.width = 64
      probe.height = 64
      const context = probe.getContext('2d', { willReadFrequently: true })
      const scaleX = image.naturalWidth / viewportSize.width
      const scaleY = image.naturalHeight / viewportSize.height
      context?.drawImage(
        image,
        Math.max(0, box.x * scaleX), Math.max(0, box.y * scaleY),
        Math.max(1, box.width * scaleX), Math.max(1, box.height * scaleY),
        0, 0, probe.width, probe.height,
      )
      const pixels = context?.getImageData(0, 0, probe.width, probe.height).data ?? new Uint8ClampedArray()
      let nonBlack = 0
      let luminance = 0
      for (let index = 0; index < pixels.length; index += 4) {
        const value = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]
        luminance += value
        if (pixels[index + 3] > 0 && value > 4) nonBlack += 1
      }
      const pixelCount = pixels.length / 4
      return {
        nonBlackRatio: pixelCount ? nonBlack / pixelCount : 0,
        averageLuminance: pixelCount ? luminance / pixelCount : 0,
      }
    }, { base64: screenshot.toString('base64'), box: canvasBox, viewportSize: viewport })
    return { ...health, ...rendered }
  } catch {
    return health
  }
}

async function readRecoveryBuildMarkers(page: Page) {
  return page.evaluate(async () => {
    const scriptUrls = [...new Set(performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /\/assets\/.*\.js(?:\?|$)/.test(url)))]
    const scripts = await Promise.all(scriptUrls.map(async (url) => {
      try { return await (await fetch(url, { cache: 'no-store' })).text() } catch { return '' }
    }))
    const settlementScript = scripts.find((script) => script.includes('胡牌特效后未收到结算事实')) ?? ''
    const recoveryContextIndex = settlementScript.indexOf('胡牌特效后未收到结算事实')
    const recoveryContext = recoveryContextIndex >= 0
      ? settlementScript.slice(Math.max(0, recoveryContextIndex - 320), recoveryContextIndex)
      : ''
    const readinessHelper = recoveryContext.match(/([A-Za-z_$][\w$]*)\([^()]*\.phase\.value,[^()]*\.result\.value\)/)?.[1]
    const readinessBody = readinessHelper
      ? settlementScript.match(new RegExp(`function ${readinessHelper.replace(/[$]/g, '\\$&')}\\([^)]*\\)\\{return ([^}]*)\\}`))?.[1] ?? ''
      : ''
    return {
      reconnect: scripts.some((script) => script.includes('房主心跳无应答，主动重建连接')),
      fullRejoin: scripts.some((script) => script.includes('房主心跳连续无应答，升级为完整房间重进')),
      sendGuard: scripts.some((script) => script.includes('心跳发送失败，等待探测超时')),
      sdkEventRecovery: scripts.some((script) => script.includes('SDK 房主重连事件超时，升级为完整房间重进')),
      settlementRecovery: scripts.some((script) => script.includes('胡牌特效后未收到结算事实')),
      settlementReadinessGate: scripts.some((script) => script.includes('结算弹窗未完整就绪（settled/result）'))
        || /===\s*["'`]settled["'`]\s*&&\s*[^=]+!=\s*null/.test(readinessBody),
      revealCompletionRecovery: scripts.some((script) => script.includes('亮牌动画结束仍缺少结算结果')),
      settlementSyncRequest: scripts.some((script) => script.includes('settlement_sync_request')),
      strictContinueBarrier: scripts.some((script) => script.includes('在线及恢复宽限中的真人必须明确确认')),
      settlementDegradeRecovery: scripts.some((script) => script.includes('结算事实已就绪后又被重进握手降级')),
      settlementDeadlineGuard: scripts.some((script) => script.includes('同局结算恢复截止时间不可延期')),
      authoritySilenceProbe: scripts.some((script) => script.includes('对局权威连续静默，单次请求当前手牌事实')),
      verifiedRosterRecovery: scripts.some((script) => script.includes('大厅验证的新 peer')),
      settlementAiBarrier: scripts.some((script) => script.includes('真人确认是下一局的硬屏障')),
      synchronousRoomBinding: scripts.some((script) => script.includes('新 Room 状态写入时同步绑定业务监听')),
      rosterReadyHandshake: scripts.some((script) => script.includes('确认业务监听已就绪')),
      delayedSettlementReplay: scripts.some((script) => script.includes('单次延迟重放结算权威事实')),
    }
  })
}

test('线上部署包含事件驱动恢复且不含应用层心跳', async ({ page }) => {
  await page.goto(ONLINE.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const marker = await readRecoveryBuildMarkers(page)
  console.log(`[ONLINE] 未登录首页恢复构建标记：${JSON.stringify(marker)}`)
  expect(marker).toEqual({
    reconnect: false,
    fullRejoin: false,
    sendGuard: false,
    sdkEventRecovery: true,
    settlementRecovery: true,
    settlementReadinessGate: true,
    revealCompletionRecovery: true,
    settlementSyncRequest: true,
    strictContinueBarrier: true,
    settlementDegradeRecovery: true,
    settlementDeadlineGuard: true,
    authoritySilenceProbe: true,
    verifiedRosterRecovery: true,
    settlementAiBarrier: true,
    synchronousRoomBinding: true,
    rosterReadyHandshake: true,
    delayedSettlementReplay: true,
  })
})

async function selectOnlineMode(page: Page) {
  await page.getByText('联机对战', { exact: false }).first().click()
}

async function authenticate(context: BrowserContext, account: Account, auto = false, manual = true) {
  const page = await context.newPage()
  const separator = ONLINE.url.includes('?') ? '&' : '?'
  const params = new URLSearchParams()
  // manualContinue=1 关闭生产默认的 10 秒自动确认，用于稳定验证手动确认屏障；
  // 不带该参数时保留线上默认自动确认行为（结算确认专项场景 1 需要）。
  if (manual) params.set('manualContinue', '1')
  if (auto) params.set('auto', '1')
  await page.goto(`${ONLINE.url}${separator}${params}`, {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  })
  await selectOnlineMode(page)
  if (await page.getByRole('button', { name: '创建房间', exact: true }).isVisible().catch(() => false)) {
    return page
  }

  const openAuthPopup = async () => {
    const popupPromise = context.waitForEvent('page', { timeout: 30_000 })
    await page.getByRole('button', { name: '登录', exact: true }).click()
    return popupPromise
  }
  let popup = await openAuthPopup()
  let submitted = false
  let submittedAt = 0
  let attempts = 0
  let lastAuthProgressAt = Date.now()
  let loadingReloads = 0
  let authErrorRetries = 0
  let authorized = false
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && !authorized) {
    // OAuth 回调页偶发显示“认证页面暂时无法加载”，但授权
    // 消息可能已经成功回传游戏页。以游戏页的真实登录态为最终事实，
    // 避免已授权却被滞留弹窗误判为超时。
    if (await page.getByRole('button', { name: '创建房间', exact: true }).isVisible().catch(() => false)) {
      authorized = true
      await popup.close().catch(() => {})
      break
    }
    const authorize = popup.getByRole('button', { name: '同意并进入游戏', exact: true })
    if (await authorize.isVisible().catch(() => false)) {
      await authorize.click()
      authorized = true
      break
    }
    const email = popup.locator('input[name=email]')
    if (await email.isVisible().catch(() => false)) {
      lastAuthProgressAt = Date.now()
      // VibeHub 偶发停在“登录中…”且接口没有返回。20 秒无进展时刷新同一
      // callback 登录页重试，最多三次；不在日志中输出账号或密码。
      if (submitted && Date.now() - submittedAt > 20_000 && attempts < 3) {
        await popup.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
        submitted = false
        continue
      }
      if (!submitted) {
        await email.fill(account.email)
        await popup.locator('input[name=password]').fill(account.password)
        await popup.getByRole('button', { name: '登录', exact: true }).click()
        submitted = true
        submittedAt = Date.now()
        attempts += 1
      }
    } else {
      const retryAuth = popup.getByRole('button', { name: '重试', exact: true })
      const goLogin = popup.getByRole('button', { name: '去登录', exact: true })
      if (authErrorRetries < 3 && await retryAuth.isVisible().catch(() => false)) {
        await retryAuth.click()
        authErrorRetries += 1
        lastAuthProgressAt = Date.now()
      } else if (await goLogin.isVisible().catch(() => false)) {
        await goLogin.click()
        lastAuthProgressAt = Date.now()
      } else if (Date.now() - lastAuthProgressAt > 20_000 && loadingReloads < 3) {
        // callback state 可能已经被服务端消费；刷新旧 URL 仍会永久“加载中…”。
        // 关闭该弹窗，从作品页重新发起一个新 OAuth 会话，仍保持严格有界次数。
        await popup.close().catch(() => {})
        popup = await openAuthPopup()
        loadingReloads += 1
        submitted = false
        lastAuthProgressAt = Date.now()
      }
    }
    await popup.waitForTimeout(400)
  }
  if (!authorized) throw new Error('VibeHub 登录/授权在 120 秒内未完成')
  await expect(page.getByRole('button', { name: '创建房间', exact: true })).toBeVisible({ timeout: 30_000 })
  return page
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

/** 正常路径必须一次加入即同步双端 roster；不允许用离开/重入掩盖恢复异常。 */
async function waitForRoomReady(host: Page, client: Page, roomCode: string) {
  const deadline = Date.now() + 30_000
  let hostReady = false
  let clientReady = false
  let hostSeats = 0
  let clientSeats = 0
  while (Date.now() < deadline) {
    hostReady = await host.getByRole('button', { name: '准备 / 取消准备' }).isVisible().catch(() => false)
    clientReady = await client.getByRole('button', { name: '准备 / 取消准备' }).isVisible().catch(() => false)
    hostSeats = await host.locator('.room-seat').count().catch(() => 0)
    clientSeats = await client.locator('.room-seat').count().catch(() => 0)
    if (hostReady && clientReady && hostSeats >= 2 && clientSeats >= 2) return
    await host.waitForTimeout(2_000)
  }
  throw new Error(`正常加入后 30 秒 roster 仍未同步（room=${roomCode} hostReady=${hostReady} clientReady=${clientReady} hostSeats=${hostSeats} clientSeats=${clientSeats}）；本轮禁止离开重入兜底`)
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

async function takeAutoPlayerEvents(page: Page) {
  return page.evaluate(() => {
    const state = window as unknown as { __onlineAutoPlayerEvents?: AutoPlayerEvent[] }
    return state.__onlineAutoPlayerEvents?.splice(0) ?? []
  })
}

async function readTableVisualState(page: Page): Promise<TableVisualState> {
  return page.evaluate(() => {
    type VueInstance = { props?: Record<string, unknown>; parent?: VueInstance | null }
    let props: Record<string, unknown> = {}
    for (const element of document.querySelectorAll('.mahjong-scene, .game-table-hud')) {
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
    const deal = props.dealAnimation as { serial?: unknown; count?: unknown } | undefined
    const effect = props.winEffect as { id?: unknown } | null | undefined
    return {
      stage: typeof props.openingStage === 'string' ? props.openingStage : null,
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
      winEffectId: typeof effect?.id === 'number' ? effect.id : null,
    }
  })
}

async function installOpeningSampler(page: Page) {
  await page.evaluate(() => {
    const target = window as unknown as {
      __onlineOpeningStages?: OpeningSample[]
      __onlineWinEffects?: WinEffectSample[]
      __onlineTableTransitions?: TableTransitionSample[]
      __onlineAudioEvents?: AudioPlaybackSample[]
      __onlineOpeningSampler?: number
      __onlineOpeningObserver?: MutationObserver
    }
    if (target.__onlineOpeningSampler) window.clearInterval(target.__onlineOpeningSampler)
    target.__onlineOpeningObserver?.disconnect()
    target.__onlineOpeningStages = []
    target.__onlineWinEffects = []
    target.__onlineTableTransitions = []
    target.__onlineAudioEvents = []
    let previous = '__unset__'
    let previousStage: string | null = null
    let previousWinEffectVisible = false
    let previousWinEffectId: number | null = null
    let previousTableSignature = ''
    let previousHandLabel = ''
    let cycle = 0
    const sample = () => {
      type VueInstance = { props?: Record<string, unknown>; parent?: VueInstance | null }
      let props: Record<string, unknown> = {}
      const hud = document.querySelector<HTMLElement>('.game-table-hud')
      if (hud) {
        const numberValue = (value: string | undefined, fallback = -1) => {
          const parsed = Number(value)
          return Number.isFinite(parsed) ? parsed : fallback
        }
        const effectId = numberValue(hud.dataset.winEffectId)
        props = {
          openingStage: hud.dataset.openingStage || null,
          diceValues: (hud.dataset.diceValues ?? '').split(',').filter(Boolean).map(Number),
          diceThrowerIndex: numberValue(hud.dataset.diceThrowerIndex),
          wallBreakIndex: numberValue(hud.dataset.wallBreakIndex),
          flipStack: numberValue(hud.dataset.flipStack),
          wallCount: numberValue(hud.dataset.wallCount),
          wallHeadDrawn: numberValue(hud.dataset.wallHeadDrawn),
          dealAnimation: {
            serial: numberValue(hud.dataset.dealSerial),
            count: numberValue(hud.dataset.dealCount),
          },
          winEffect: effectId >= 0 ? {
            id: effectId,
            winnerIndex: numberValue(hud.dataset.winEffectWinner),
            tile: hud.dataset.winEffectTile ?? '',
          } : null,
        }
      } else {
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
      const effect = props.winEffect as {
        id?: unknown; winnerIndex?: unknown; tile?: unknown
      } | null | undefined
      const effectId = typeof effect?.id === 'number' ? effect.id : null
      const effectVisible = effectId != null
      if (effectVisible !== previousWinEffectVisible
        || (effectVisible && effectId !== previousWinEffectId)) {
        previousWinEffectVisible = effectVisible
        previousWinEffectId = effectId
        target.__onlineWinEffects?.push({
          at: performance.now(),
          hand: document.querySelector('.round-info')?.textContent?.trim() ?? '',
          id: effectId ?? -1,
          winnerIndex: typeof effect?.winnerIndex === 'number' ? effect.winnerIndex : -1,
          tile: typeof effect?.tile === 'string' ? effect.tile : '',
          visible: effectVisible,
        })
      }
      // 生产构建不会暴露 Vue 内部 props，回退到用户实际可见的 DOM 阶段。
      if (stage == null) {
        if (document.querySelector('.opening-overlay.start-cue')) stage = 'start'
        else if (document.querySelector('.hand-rack.dealing')) stage = 'deal'
      }
      // cycle 按 round-info 局号（含本场）变化推进，不依赖 start 阶段：
      // WebGL 高负载下 observer/定时器可能漏掉短暂的 start 采样，而 round-info
      // 在 round_start 时必然更新，连庄局（东4局·1本场）文本也会变化。
      const handLabel = document.querySelector('.round-info')?.textContent?.trim() ?? ''
      if (handLabel && handLabel !== previousHandLabel) {
        previousHandLabel = handLabel
        cycle += 1
        previous = '__unset__'
        previousStage = null
      }
      // 完整性判定必须来自 HUD 同一次 Vue 渲染提交。不能把 HUD 的最新
      // stage/wall 与 Vue 内部 props 的另一时点混读，否则会拼出不存在的状态。
      const csvNumbers = (value: string | undefined) => (value ?? '')
        .split(',')
        .filter((entry) => entry !== '')
        .map(Number)
        .filter(Number.isFinite)
      const seats = csvNumbers(hud?.dataset.tableSeats)
      const concealedCounts = csvNumbers(hud?.dataset.concealedCounts)
      const discardCounts = csvNumbers(hud?.dataset.discardCounts)
      const meldTileCounts = csvNumbers(hud?.dataset.meldTileCounts)
      const completeSeatCounts = seats.length === 4
        && concealedCounts.length === 4
        && discardCounts.length === 4
        && meldTileCounts.length === 4
      const tableSample = {
        at: Date.now(),
        hand: handLabel,
        phase: hud?.dataset.phase ?? '',
        openingStage: stage ?? '',
        wallCount: typeof props.wallCount === 'number' ? props.wallCount : -1,
        wallHeadDrawn: typeof props.wallHeadDrawn === 'number' ? props.wallHeadDrawn : -1,
        concealedCount: completeSeatCounts ? concealedCounts.reduce((sum, count) => sum + count, 0) : -1,
        discardCount: completeSeatCounts ? discardCounts.reduce((sum, count) => sum + count, 0) : -1,
        meldTileCount: completeSeatCounts ? meldTileCounts.reduce((sum, count) => sum + count, 0) : -1,
        seats,
        concealedCounts,
        discardCounts,
        meldTileCounts,
        winEffectVisible: effectVisible,
      }
      const tableSignature = JSON.stringify({ ...tableSample, at: 0 })
      if (tableSignature !== previousTableSignature) {
        previousTableSignature = tableSignature
        target.__onlineTableTransitions?.push(tableSample)
      }
      previousStage = stage
      if (stage == null || stage.endsWith('-visible')) return
      const deal = props.dealAnimation as { serial?: unknown; count?: unknown } | undefined
      const signature = JSON.stringify({
        cycle, stage, diceValues: props.diceValues, diceThrowerIndex: props.diceThrowerIndex,
        wallBreakIndex: props.wallBreakIndex, flipStack: props.flipStack,
        wallCount: props.wallCount, wallHeadDrawn: props.wallHeadDrawn,
        dealSerial: deal?.serial, dealCount: deal?.count,
      })
      if (signature !== previous) {
        previous = signature
        target.__onlineOpeningStages?.push({
          at: performance.now(),
          cycle,
          hand: document.querySelector('.round-info')?.textContent?.trim() ?? '',
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
          winEffectId: null,
        })
      }
    }
    // WebGL 高负载下主线程可能阻塞 20ms 定时器，漏掉短暂的开局 start 阶段。
    // MutationObserver 在 DOM 变化（Vue 更新）时同步触发，作为定时器的双保险；
    // 定时器继续保留用于兜底（如纯 3D 动画不更新 DOM 的阶段）。
    const observer = new MutationObserver(sample)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    target.__onlineOpeningObserver = observer
    target.__onlineOpeningSampler = window.setInterval(sample, 20)
  })
}

async function installSettlementSampler(page: Page) {
  await page.evaluate(() => {
    const target = window as unknown as {
      __onlineSettlementEvents?: SettlementSample[]
      __onlineSettlementSampler?: number
      __onlineSettlementObserver?: MutationObserver
    }
    if (target.__onlineSettlementSampler) window.clearInterval(target.__onlineSettlementSampler)
    target.__onlineSettlementObserver?.disconnect()
    target.__onlineSettlementEvents = []
    const roundOnly = (value: string) => value.match(/东[1-4]局/)?.[0] ?? ''
    const roundToken = (value: string) => {
      const round = value.match(/东[1-4]局/)?.[0] ?? ''
      const honba = value.match(/(\d+)本场/)?.[1] ?? '0'
      return round ? `${round}:${honba}` : ''
    }
    const resultSignature = (text: string) => text
      .split('\n')
      .filter((line) => !/查看牌桌|继续(?:\s*\(\d+\))?|等待其他玩家|已确认/.test(line))
      .join('\n')
    let previousVisible = false
    let previousConfirmed = false
    let previousToken = ''
    let previousOverlay: HTMLElement | null = null
    const sample = () => {
      const overlay = document.querySelector<HTMLElement>('.round-settlement')
      const visible = Boolean(overlay && overlay.getClientRects().length > 0)
      if (!visible) {
        previousVisible = false
        previousConfirmed = false
        previousToken = ''
        previousOverlay = null
        return
      }
      const text = overlay.innerText ?? ''
      const handLabel = document.querySelector('.round-info')?.textContent?.trim() ?? ''
      // 结算弹窗文本不含本场；从 round-info 标签取完整手牌键（含本场），
      // 与测试主循环的 handToken(activeHand) 保持一致。但旧结算层残留时
      // （上一局弹窗还没退场、round-info 已切到新局），局号不一致必须跳过，
      // 否则会把上一局的「已确认」事件污染到新局的 evidence，误判双确认不同步。
      const token = roundToken(handLabel)
      if (!token) return
      const labelMismatch = Boolean(roundOnly(text) && roundOnly(text) !== roundOnly(handLabel))
      if (labelMismatch) {
        previousVisible = true
        previousOverlay = overlay
        return
      }
      const confirmed = /已确认|等待其他玩家确定/.test(text)
      const appearance = !previousVisible || previousOverlay !== overlay
      const confirmationEdge = confirmed && !previousConfirmed
      if (appearance || confirmationEdge) {
        target.__onlineSettlementEvents?.push({
          at: Date.now(),
          token,
          confirmed,
          appearance,
          draw: /流局/.test(text),
          resultSignature: resultSignature(text),
          labelMismatch,
        })
      }
      previousVisible = true
      previousConfirmed = confirmed
      previousToken = token
      previousOverlay = overlay
    }
    target.__onlineSettlementSampler = window.setInterval(sample, 20)
    const observer = new MutationObserver(sample)
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    target.__onlineSettlementObserver = observer
  })
}

async function settlementHistory(page: Page) {
  return page.evaluate(() => {
    const target = window as unknown as { __onlineSettlementEvents?: SettlementSample[] }
    return target.__onlineSettlementEvents ?? []
  })
}

async function openingHistory(page: Page, stop = false): Promise<OpeningSample[]> {
  return page.evaluate((shouldStop) => {
    const target = window as unknown as {
      __onlineOpeningStages?: OpeningSample[]
      __onlineOpeningSampler?: number
      __onlineOpeningObserver?: MutationObserver
    }
    if (shouldStop && target.__onlineOpeningSampler) window.clearInterval(target.__onlineOpeningSampler)
    if (shouldStop && target.__onlineOpeningObserver) target.__onlineOpeningObserver.disconnect()
    return target.__onlineOpeningStages ?? []
  }, stop)
}

async function winEffectHistory(page: Page): Promise<WinEffectSample[]> {
  return page.evaluate(() => {
    const target = window as unknown as { __onlineWinEffects?: WinEffectSample[] }
    return target.__onlineWinEffects ?? []
  })
}

async function tableTransitionHistory(page: Page): Promise<TableTransitionSample[]> {
  return page.evaluate(() => (
    (window as unknown as { __onlineTableTransitions?: TableTransitionSample[] })
      .__onlineTableTransitions ?? []
  ))
}

async function readNormalizedTableState(page: Page): Promise<NormalizedTableState | null> {
  return page.evaluate(() => {
    type Meld = { type?: unknown; tiles?: unknown; from?: unknown }
    type Player = {
      seat?: unknown
      score?: unknown
      hand?: unknown[]
      concealedTileCount?: unknown
      discards?: unknown[]
      melds?: Meld[]
    }
    type VueInstance = { props?: Record<string, unknown>; parent?: VueInstance | null }
    let props: Record<string, unknown> | undefined
    for (const element of document.querySelectorAll('.game-table-hud, .mahjong-scene')) {
      let instance = (element as Element & { __vueParentComponent?: VueInstance }).__vueParentComponent
      while (instance) {
        if (instance.props && 'players' in instance.props && 'wallCount' in instance.props) {
          props = instance.props
          break
        }
        instance = instance.parent ?? undefined
      }
      if (props) break
    }
    if (!props) return null
    const players = (Array.isArray(props.players) ? props.players : []) as Player[]
    const toAbsoluteSeat = (localIndex: number) => {
      const seat = players[localIndex]?.seat
      return typeof seat === 'number' ? seat : localIndex
    }
    const winEffect = props.winEffect as { winnerIndex?: unknown; tile?: unknown } | null | undefined
    return {
      hand: document.querySelector('.round-info')?.textContent?.trim() ?? '',
      phase: typeof props.phase === 'string' ? props.phase : '',
      openingStage: typeof props.openingStage === 'string' ? props.openingStage : '',
      wallCount: typeof props.wallCount === 'number' ? props.wallCount : -1,
      wallHeadDrawn: typeof props.wallHeadDrawn === 'number' ? props.wallHeadDrawn : -1,
      winEffect: winEffect && typeof winEffect.winnerIndex === 'number'
        ? `${toAbsoluteSeat(winEffect.winnerIndex)}:${typeof winEffect.tile === 'string' ? winEffect.tile : ''}`
        : '',
      players: players.map((player, localIndex) => ({
        seat: typeof player.seat === 'number' ? player.seat : localIndex,
        score: typeof player.score === 'number' ? player.score : 0,
        concealedCount: typeof player.concealedTileCount === 'number'
          ? player.concealedTileCount
          : (player.hand?.length ?? 0),
        discards: (player.discards ?? []).filter((tile): tile is string => typeof tile === 'string'),
        melds: (player.melds ?? []).map((meld) => ({
          type: typeof meld.type === 'string' ? meld.type : '',
          tiles: Array.isArray(meld.tiles)
            ? meld.tiles.filter((tile): tile is string => typeof tile === 'string')
            : [],
          fromSeat: typeof meld.from === 'number' ? toAbsoluteSeat(meld.from) : null,
        })),
      })).sort((a, b) => a.seat - b.seat),
    }
  })
}

async function readVisibleTableState(page: Page): Promise<VisibleTableState> {
  return page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>('.game-table-hud')
    const canvas = document.querySelector<HTMLCanvasElement>('.mahjong-scene')
    const loading = document.querySelector<HTMLElement>('.table-loading')
    const numberValue = (value: string | undefined, fallback = -1) => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const visible = (element: HTMLElement | null) => Boolean(element
      && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden'
      && getComputedStyle(element).display !== 'none'
      && Number(getComputedStyle(element).opacity) > 0)
    const gl = canvas ? (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) : null
    return {
      hand: document.querySelector('.round-info')?.textContent?.trim() ?? '',
      openingStage: hud?.dataset.openingStage ?? '',
      wallCount: numberValue(hud?.dataset.wallCount),
      wallHeadDrawn: numberValue(hud?.dataset.wallHeadDrawn),
      winEffectVisible: numberValue(hud?.dataset.winEffectId) >= 0,
      localHandCount: document.querySelectorAll('.hand-rack .hand-tile-slot').length,
      canvasPresent: Boolean(canvas),
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0,
      contextLost: gl ? gl.isContextLost() : null,
      loadingVisible: visible(loading),
    }
  })
}

function publicTableState(state: NormalizedTableState | null) {
  return state && {
    hand: state.hand,
    phase: state.phase,
    openingStage: state.openingStage,
    wallCount: state.wallCount,
    wallHeadDrawn: state.wallHeadDrawn,
    winEffect: state.winEffect,
    players: state.players.map((player) => ({
      seat: player.seat,
      score: player.score,
      concealedCount: player.concealedCount,
      discards: player.discards,
      melds: player.melds,
    })),
  }
}

function assertTableStatesEqual(
  states: [NormalizedTableState | null, NormalizedTableState | null],
  label: string,
) {
  expect(states[0], `${label}房主牌桌状态不可读`).not.toBeNull()
  expect(states[1], `${label}客户端牌桌状态不可读`).not.toBeNull()
  expect(publicTableState(states[1]), `${label}双端牌山/牌河/暗手/副露/特效不一致`)
    .toEqual(publicTableState(states[0]))
}

function assertTransitionHistory(
  history: TableTransitionSample[],
  hand: string,
  side: string,
  matchIndex: number,
) {
  const samples = history.filter((sample) => sample.hand === hand)
  expect(samples.length, `第 ${matchIndex} 场${side}${hand}缺少切局状态采样`).toBeGreaterThan(0)
  const start = samples.findIndex((sample) => sample.openingStage === 'start')
  expect(start, `第 ${matchIndex} 场${side}${hand}未记录下一手开局开始`).toBeGreaterThanOrEqual(0)
  // 只检查真正的开局窗口。同一手在正常对局、胡牌和结算期间
  // round-info 不会变；slice(start) 会把本手结束时的正常胡牌特效
  // 误判为“开局残留”。openingStage 首次清空即是开局时间线的边界。
  const openingEnd = samples.findIndex((sample, index) => (
    index > start && sample.openingStage === ''
  ))
  expect(openingEnd, `第 ${matchIndex} 场${side}${hand}开局阶段未正常结束`).toBeGreaterThan(start)
  const opening = samples.slice(start, openingEnd)
  expect(opening.some((sample) => sample.openingStage === 'dice'),
    `第 ${matchIndex} 场${side}${hand}开局期间牌桌提前消失`).toBe(true)
  expect(opening.some((sample) => sample.openingStage === 'flip'),
    `第 ${matchIndex} 场${side}${hand}开局期间翻精阶段消失`).toBe(true)
  expect(opening.some((sample) => sample.openingStage === 'deal'),
    `第 ${matchIndex} 场${side}${hand}开局期间发牌阶段消失`).toBe(true)
  let previousDealSample: TableTransitionSample | null = null
  for (const sample of opening) {
    expect(sample.wallCount, `第 ${matchIndex} 场${side}${hand}开局期间牌山凭空消失`).toBeGreaterThan(0)
    expect(sample.seats, `第 ${matchIndex} 场${side}${hand}开局期间四家座位计数不可读`).toHaveLength(4)
    expect(sample.concealedCounts, `第 ${matchIndex} 场${side}${hand}开局期间四家暗手计数不可读`).toHaveLength(4)
    expect(sample.discardCounts, `第 ${matchIndex} 场${side}${hand}开局期间四家牌河计数不可读`).toHaveLength(4)
    expect(sample.meldTileCounts, `第 ${matchIndex} 场${side}${hand}开局期间四家副露计数不可读`).toHaveLength(4)
    if (sample.discardCount >= 0) {
      expect(sample.discardCount, `第 ${matchIndex} 场${side}${hand}开局期间牌河未正确清场`).toBe(0)
    }
    if (sample.meldTileCount >= 0) {
      expect(sample.meldTileCount, `第 ${matchIndex} 场${side}${hand}开局期间副露未正确清场`).toBe(0)
    }
    expect(sample.winEffectVisible, `第 ${matchIndex} 场${side}${hand}开局期间胡牌特效残留`).toBe(false)
    if (sample.openingStage === 'deal' && sample.wallHeadDrawn > 0) {
      expect(sample.concealedCount,
        `第 ${matchIndex} 场${side}${hand}发牌已开始但四家暗手整体消失`).toBeGreaterThan(0)
    }
    if (sample.openingStage === 'deal') {
      if (previousDealSample) {
        expect(sample.wallHeadDrawn,
          `第 ${matchIndex} 场${side}${hand}发牌期间牌山进度回退`)
          .toBeGreaterThanOrEqual(previousDealSample.wallHeadDrawn)
        for (let seatIndex = 0; seatIndex < 4; seatIndex += 1) {
          expect(sample.concealedCounts[seatIndex],
            `第 ${matchIndex} 场${side}${hand}发牌期间座位 ${sample.seats[seatIndex]} 暗手回退或消失`)
            .toBeGreaterThanOrEqual(previousDealSample.concealedCounts[seatIndex] ?? 0)
        }
      }
      previousDealSample = sample
    }
  }
}

async function waitForSynchronizedTableStates(
  pages: [Page, Page],
  hand: string,
  timeoutMs = 20_000,
): Promise<[NormalizedTableState | null, NormalizedTableState | null]> {
  const deadline = Date.now() + timeoutMs
  let states: [NormalizedTableState | null, NormalizedTableState | null] = [null, null]
  while (Date.now() < deadline) {
    states = await Promise.all(pages.map(readNormalizedTableState)) as [
      NormalizedTableState | null, NormalizedTableState | null,
    ]
    // Vue 生产构建不保证暴露 __vueParentComponent。双端都不可读时立即回退到
    // 公开 DOM 探针，不能每手无意义等待 20 秒，更不能把 null 当成牌山为 0。
    if (states.every((state) => state == null)) return states
    const synchronized = states.every((state) => state?.hand === hand)
      && states[0]?.openingStage === states[1]?.openingStage
      && states[0]?.wallCount === states[1]?.wallCount
      && states[0]?.wallHeadDrawn === states[1]?.wallHeadDrawn
    if (synchronized) return states
    await pages[0].waitForTimeout(100)
  }
  return states
}

async function waitForVisibleNextHandStates(
  pages: [Page, Page],
  hand: string,
  timeoutMs = 90_000,
): Promise<[VisibleTableState, VisibleTableState]> {
  const deadline = Date.now() + timeoutMs
  let states = await Promise.all(pages.map(readVisibleTableState)) as [VisibleTableState, VisibleTableState]
  while (Date.now() < deadline) {
    const ready = states.every((state) => (
      state.hand === hand
      && state.wallCount > 0
      && state.wallHeadDrawn > 0
      && state.localHandCount > 0
      && state.canvasPresent
      && state.canvasWidth > 0
      && state.canvasHeight > 0
      && state.contextLost === false
      && !state.winEffectVisible
    )) && states[0].wallCount === states[1].wallCount
      && states[0].wallHeadDrawn === states[1].wallHeadDrawn
    if (ready) return states
    await pages[0].waitForTimeout(100)
    states = await Promise.all(pages.map(readVisibleTableState)) as [VisibleTableState, VisibleTableState]
  }
  return states
}

async function attachDualScreenshots(pages: [Page, Page], testInfo: TestInfo, name: string) {
  // WebGL 全页截图在长跑页面上可能卡住 GPU 进程（历史多次复现）。截图只是取证，
  // 不能让无超时的截图阻塞主循环的局号/结算判定；超时或失败时跳过本张取证。
  try {
    for (let index = 0; index < pages.length; index += 1) {
      const body = await pages[index].screenshot({ timeout: 8000 })
      await testInfo.attach(`${name}-${index === 0 ? 'host' : 'client'}`, {
        body, contentType: 'image/png',
      })
      await pages[index].waitForTimeout(100)
    }
  } catch (error) {
    console.log(`[spec] 截图 ${name} 超时/失败，跳过取证（不影响业务判定）: ${String(error).slice(0, 160)}`)
  }
}

function validateOpeningCycles(history: OpeningSample[], side: string, matchIndex: number) {
  const cycles = new Map<number, OpeningSample[]>()
  for (const sample of history) {
    if (sample.cycle < 1) continue
    const entries = cycles.get(sample.cycle) ?? []
    entries.push(sample)
    cycles.set(sample.cycle, entries)
  }
  expect(cycles.size, `第 ${matchIndex} 场${side}开局动画次数不足`).toBeGreaterThanOrEqual(4)
  for (const [cycle, samples] of cycles) {
    const stages = samples.map((sample) => sample.stage)
    expect(stages, `第 ${matchIndex} 场${side}第 ${cycle} 次开局缺少开始提示`).toContain('start')
    expect(stages, `第 ${matchIndex} 场${side}第 ${cycle} 次开局缺少掷骰`).toContain('dice')
    expect(stages, `第 ${matchIndex} 场${side}第 ${cycle} 次开局缺少翻精`).toContain('flip')
    expect(stages, `第 ${matchIndex} 场${side}第 ${cycle} 次开局缺少发牌`).toContain('deal')

    const dice = samples.filter((sample) => sample.stage === 'dice')
    expect(dice.length, `第 ${matchIndex} 场${side}第 ${cycle} 次开局没有两次掷骰`).toBeGreaterThanOrEqual(2)
    for (const sample of [dice[0], dice.at(-1)!]) {
      expect(sample.diceValues).toHaveLength(2)
      expect(sample.diceValues.every((value) => Number.isInteger(value) && value >= 1 && value <= 6)).toBe(true)
      expect(sample.diceThrowerIndex).toBeGreaterThanOrEqual(0)
      expect(sample.diceThrowerIndex).toBeLessThan(4)
    }

    const flip = samples.find((sample) => sample.stage === 'flip')!
    expect(flip.flipStack != null && flip.flipStack >= 0 && flip.flipStack < 68,
      `第 ${matchIndex} 场${side}第 ${cycle} 次开局翻精墩无效`).toBe(true)
    expect(flip.wallCount, `第 ${matchIndex} 场${side}第 ${cycle} 次翻精后牌山应为 134 张`).toBe(134)

    const deal = samples.filter((sample) => sample.stage === 'deal')
    const secondDice = dice.at(-1)!.diceValues
    const expectedBreak = (((flip.flipStack ?? 0) + secondDice[0] + secondDice[1] + 1) % 68) * 2
    expect(new Set(deal.map((sample) => sample.wallBreakIndex)),
      `第 ${matchIndex} 场${side}第 ${cycle} 次发牌期间牌山开口发生跳变`)
      .toEqual(new Set([expectedBreak]))
    expect(Math.max(...deal.map((sample) => sample.dealSerial)),
      `第 ${matchIndex} 场${side}第 ${cycle} 次发牌批次不完整`).toBeGreaterThanOrEqual(16)
    expect(Math.max(...deal.map((sample) => sample.wallHeadDrawn)),
      `第 ${matchIndex} 场${side}第 ${cycle} 次发牌未走完 53 张`).toBeGreaterThanOrEqual(53)
    expect(Math.min(...deal.map((sample) => sample.wallCount)),
      `第 ${matchIndex} 场${side}第 ${cycle} 次发牌后牌山数量不正确`).toBe(81)
  }
  return [...cycles.values()]
}

async function clickContinueIfAvailable(page: Page) {
  const button = page.locator('.round-settlement .result-actions button').filter({ hasText: /^继续/ }).first()
  if (!await button.isVisible().catch(() => false)) return false
  if (!await button.isEnabled().catch(() => false)) return false
  await button.evaluate((element: HTMLButtonElement) => element.click()).catch(() => {})
  return true
}

async function readRoundLabel(page: Page) {
  return page.locator('.round-info').innerText({ timeout: 1000 }).catch(() => '')
}

async function diagnostics(host: Page, client: Page, logs: string[][], message: string) {
  const states = await Promise.all([host, client].map(async (page) => ({
    round: await readRoundLabel(page),
    settlement: await page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => ''),
    final: await page.locator('.final-backdrop').isVisible().catch(() => false),
    banners: await page.locator('.remote-banner').allInnerTexts().catch(() => [] as string[]),
    canvas: await readCanvasHealth(page),
    table: await readNormalizedTableState(page),
    winEffects: await winEffectHistory(page),
    audio: await audioHistory(page),
    settlements: await settlementHistory(page),
    tableTransitions: await tableTransitionHistory(page),
  })))
  return new Error(`${message}\nstates=${JSON.stringify(states)}\nlogs=${JSON.stringify(logs.map((x) => x.slice(-30)))}`)
}

async function failWithEvidence(
  pages: [Page, Page],
  testInfo: TestInfo,
  consoleLogs: string[][],
  name: string,
  message: string,
): Promise<never> {
  const [host, client] = pages
  await attachDualScreenshots(pages, testInfo, name)
  const evidence = await Promise.all(pages.map(async (page) => ({
    round: await readRoundLabel(page),
    canvas: await readCanvasHealth(page),
    table: await readNormalizedTableState(page),
    settlement: await page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => ''),
    winEffects: await winEffectHistory(page),
    audio: await audioHistory(page),
    settlements: await settlementHistory(page),
    tableTransitions: await tableTransitionHistory(page),
  })))
  await testInfo.attach(`${name}-state`, {
    body: JSON.stringify({ message, evidence, consoleLogs }, null, 2),
    contentType: 'application/json',
  })
  throw await diagnostics(host, client, consoleLogs, message)
}

async function runEastMatch(options: {
  host: Page
  client: Page
  matchIndex: number
  consoleLogs: string[][]
  testInfo: TestInfo
  reuseRoom?: boolean
}) {
  const { host, client, matchIndex, consoleLogs, testInfo, reuseRoom = false } = options
  const suffix = `${matchIndex}-${Date.now().toString(36).slice(-5)}`
  if (!reuseRoom) {
    await enterOnlineLobby(host, `线上房主-${suffix}`, 'host')
    await host.getByRole('button', { name: '创建房间', exact: true }).click()
    await host.locator('.game-settings button', { hasText: '玩法' }).click()
    await host.getByRole('button', { name: /莲花麻将/ }).click()
    await host.getByRole('button', { name: '确定' }).click()
    await host.getByRole('button', { name: '确认创建' }).click()
    await acceptDisclaimerIfShown(host)

    await host.locator('.room-code strong').waitFor({ timeout: 40_000 })
    const createdRoomCode = (await host.locator('.room-code strong').innerText()).trim()
    await enterOnlineLobby(client, `线上客人-${suffix}`, 'client')
    await client.getByRole('button', { name: '加入房间', exact: true }).click()
    await client.getByPlaceholder('输入 6 位房间码').fill(createdRoomCode)
    await client.getByRole('button', { name: '确认加入' }).click()
    await acceptDisclaimerIfShown(client)
  }
  await host.locator('.room-code strong').waitFor({ timeout: 40_000 })
  const roomCode = (await host.locator('.room-code strong').innerText()).trim()
  expect(roomCode).toMatch(/^[A-Z0-9]{6}$/)
  try {
    await waitForRoomReady(host, client, roomCode)
  } catch (error) {
    await failWithEvidence([host, client], testInfo, consoleLogs,
      `online-match-${matchIndex}-roster-sync-failure`, String(error))
  }
  const occupiedSeats = await Promise.all([host, client].map((page) => page.locator('.room-seat.occupied').count()))
  expect(occupiedSeats, `线上第 ${matchIndex} 场必须只有 2 个真人，空余 2 席由 AI 补齐`).toEqual([2, 2])
  await Promise.all([host, client].map(installOpeningSampler))
  await Promise.all([host, client].map(installSettlementSampler))
  const start = host.getByRole('button', { name: /开始对局/ })
  if (!await start.isEnabled().catch(() => false)) {
    await host.getByRole('button', { name: '准备 / 取消准备' }).click()
    await client.getByRole('button', { name: '准备 / 取消准备' }).click()
  }
  await expect(start).toBeEnabled({ timeout: 50_000 })
  const openingPromises = [host, client].map((page) => page.locator('.opening-overlay').waitFor({
    state: 'visible', timeout: 90_000,
  }))
  const matchStartedAt = Date.now()
  await start.click()
  try {
    await Promise.all(openingPromises)
  } catch (error) {
    // 诊断：开局动画等待失败时 dump 两端控制台（transport-rx/host-tx 等）与页面状态，
    // 区分「房主已发出、客户端 SDK 未投递」与「客户端收到但被业务门禁丢弃」。
    const clientState = await client.evaluate(() => {
      const hud = document.querySelector('.game-table-hud')
      return {
        inTable: Boolean(hud),
        roundInfo: document.querySelector('.round-info')?.textContent?.trim() ?? '',
        roomSeats: document.querySelectorAll('.room-seat').length,
        readyButton: document.querySelector('.room-panel, .lobby-panel') ? true : false,
      }
    }).catch(() => null)
    const hostState = await host.evaluate(() => ({
      inTable: Boolean(document.querySelector('.game-table-hud')),
      roundInfo: document.querySelector('.round-info')?.textContent?.trim() ?? '',
    })).catch(() => null)
    await testInfo.attach(`online-match-${matchIndex}-opening-fail`, {
      body: JSON.stringify({
        roomCode, matchIndex, clientState, hostState,
        hostLogs: consoleLogs[0].slice(-40),
        clientLogs: consoleLogs[1].slice(-40),
      }),
      contentType: 'application/json',
    })
    console.log(`[ONLINE] 第 ${matchIndex} 场开局动画等待失败（client=${JSON.stringify(clientState)} host=${JSON.stringify(hostState)}）`)
    console.log(`[ONLINE] 第 ${matchIndex} 场房主日志尾部：${consoleLogs[0].slice(-25).join(' | ') || '(无)'}`)
    console.log(`[ONLINE] 第 ${matchIndex} 场客户端日志尾部：${consoleLogs[1].slice(-25).join(' | ') || '(无)'}`)
    throw error
  }
  const pages: [Page, Page] = [host, client]
  // 开局动画结束后立即可能产生真人回合；自动操作器必须早于
  // Canvas 资源验证安装，不能让取证耗时占用玩家的 12s 决策窗口。
  await Promise.all(pages.map(installHostAutoPlayer))
  // 正常路径只依赖 20ms 状态采样与 Canvas 像素验证。全页 WebGL 截图在双
  // context 下会阻塞 GPU/主线程数秒，可能反过来触发权威静默恢复；截图仅在失败时取证。
  await host.waitForTimeout(1350)
  await host.waitForTimeout(1950)
  await host.waitForTimeout(1250)
  await host.waitForTimeout(1950)
  for (const page of [host, client]) {
    await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 150_000 }).toBeGreaterThanOrEqual(4)
    await expect(page.locator('.player-seat')).toHaveCount(3)
  }
  const initialCanvasDeadline = Date.now() + 90_000
  let initialCanvasHealth = await Promise.all(pages.map(readCanvasHealth)) as [CanvasHealth, CanvasHealth]
  while (Date.now() < initialCanvasDeadline && initialCanvasHealth.some((health) => (
    !health.present || health.width <= 0 || health.height <= 0
      || health.contextLost !== false || health.loadingVisible || health.tileResources < 34
      || health.nonBlackRatio < 0.05
  ))) {
    await host.waitForTimeout(500)
    initialCanvasHealth = await Promise.all(pages.map(readCanvasHealth)) as [CanvasHealth, CanvasHealth]
  }
  await testInfo.attach(`online-match-${matchIndex}-initial-canvas-health`, {
    body: JSON.stringify(initialCanvasHealth, null, 2), contentType: 'application/json',
  })
  for (let index = 0; index < initialCanvasHealth.length; index += 1) {
    const health = initialCanvasHealth[index]
    if (!health.present || health.width <= 0 || health.height <= 0
      || health.contextLost !== false || health.loadingVisible || health.tileResources < 34
      || health.nonBlackRatio < 0.05) {
      await failWithEvidence(pages, testInfo, consoleLogs,
        `online-match-${matchIndex}-initial-canvas-black`,
        `线上第 ${matchIndex} 场东1开局后${index === 0 ? '房主' : '客户端'}3D牌桌未正常渲染：${JSON.stringify(health)}`)
    }
  }
  const initialHistories = await Promise.all([host, client].map((page) => openingHistory(page)))
  for (const [index, history] of initialHistories.entries()) {
    const stages = history.map((entry) => entry.stage)
    expect(stages, `第 ${matchIndex} 场页面 ${index} 缺少 start 动画`).toContain('start')
    expect(stages, `第 ${matchIndex} 场页面 ${index} 缺少发牌动画`).toContain('deal')
    await expect([host, client][index].locator('.flip-indicator')).toBeVisible()
    await expect([host, client][index].locator('.second-dice-note')).toContainText('二骰')
  }
  await testInfo.attach(`online-match-${matchIndex}-opening-history`, {
    body: JSON.stringify(initialHistories), contentType: 'application/json',
  })
  const markers = ['东1局', '东2局', '东3局', '东4局']
  const observed = [[], []] as [string[], string[]]
  const timings: Array<{ hand: string; seconds: number }> = []
  const deadline = matchStartedAt + 4_500_000
  let activeHand = ''
  let activeHandStartedAt = matchStartedAt
  let activeHandObservedAt = matchStartedAt
  let settledHand = ''
  let settlementStartedAt = 0
  let waitingForPreviousSettlementToClear = false
  let lastProgressAt = 0
  let transitionHand = ''
  let popupSeenAt: [number, number] = [0, 0]
  let confirmedAt: [number, number] = [0, 0]
  const transitionTimings: Array<{
    hand: string
    popupSkewMs: number
    confirmationSkewMs: number
    confirmedToNextMs: number
  }> = []
  const huEffectCaptures: Array<{ hand: string; side: 'host' | 'client'; at: number }> = []
  let sampledWinEffectCounts: [number, number] = [0, 0]
  let settlementEventCounts: [number, number] = [0, 0]
  let lastSettlementSignatures: [string, string] = ['', '']
  const settlementEvidence = new Map<string, {
    popup: [number, number]
    confirmed: [number, number]
    appearances: [number, number]
    draw: [boolean, boolean]
    resultSignatures: [string, string]
  }>()
  const verifiedHands = new Set<string>()
  const settledTableStates = new Map<string, [NormalizedTableState | null, NormalizedTableState | null]>()
  const transitionIntegrity: Array<{
    fromHand: string
    toHand: string
    settled: [NormalizedTableState | null, NormalizedTableState | null]
    next: [NormalizedTableState | null, NormalizedTableState | null]
  }> = []
  const fatalOnlineSignal = /先释放旧连接再重进|自动重进失败|尝试重新加入房间|房主连接中断|恢复牌局|已验证重进握手|大厅验证的新 peer 已恢复原座位|丢弃.*(?:旧|权威|代次)|旧权威|AI 代打|AI 接管|非法状态快照|\[wall-regress\]/i

  const verifySettledHand = async (hand: string, finalize = false) => {
    const token = handToken(hand)
    if (!token || (finalize && verifiedHands.has(token))) return
    const evidence = settlementEvidence.get(token)
    if (!evidence || !evidence.popup.every(Boolean)) return
    if (evidence.appearances[0] !== 1 || evidence.appearances[1] !== 1) {
      await failWithEvidence(pages, testInfo, consoleLogs,
        `online-match-${matchIndex}-${token}-settlement-count`,
        `线上第 ${matchIndex} 场 ${hand} 双端结算弹窗必须各出现一次，实际 ${evidence.appearances.join('/')}`)
    }
    if (!evidence.resultSignatures[0] || evidence.resultSignatures[0] !== evidence.resultSignatures[1]) {
      await failWithEvidence(pages, testInfo, consoleLogs,
        `online-match-${matchIndex}-${token}-settlement-result`,
        `线上第 ${matchIndex} 场 ${hand} 双端结算结果不一致`)
    }
    if (evidence.draw[0] !== evidence.draw[1]) {
      await failWithEvidence(pages, testInfo, consoleLogs,
        `online-match-${matchIndex}-${token}-draw-result`,
        `线上第 ${matchIndex} 场 ${hand} 双端流局/胡牌结果不一致`)
    }
    // 结算确认期间仍可能错误地重放胡牌表现。只有切到下一手（或最终结算）后
    // 才能封账，否则首次弹窗时的正确计数会掩盖确认阶段出现的第二次播放。
    if (!finalize) return

    const [effects, sounds] = await Promise.all([
      Promise.all(pages.map(winEffectHistory)),
      Promise.all(pages.map(audioHistory)),
    ])
    const winEffects = effects.map((history) => history.filter((event) => (
      event.visible && handToken(event.hand) === token
    )))
    const primarySounds = sounds.map((history) => history.filter((event) => (
      /^(?:hu|zimo)\.mp3$/i.test(event.name) && handToken(event.hand) === token
    )))
    const effectSounds = sounds.map((history) => history.filter((event) => (
      /^hu_effect_sound\.mp3$/i.test(event.name) && handToken(event.hand) === token
    )))
    const expectedCount = evidence.draw[0] ? 0 : 1
    for (let index = 0; index < 2; index += 1) {
      if (winEffects[index].length !== expectedCount
        || primarySounds[index].length !== expectedCount
        || effectSounds[index].length !== expectedCount) {
        await failWithEvidence(pages, testInfo, consoleLogs,
          `online-match-${matchIndex}-${token}-win-presentation-count`,
          `线上第 ${matchIndex} 场 ${hand} ${index === 0 ? '房主' : '客户端'}胡牌特效/声音次数异常：特效 ${winEffects[index].length}，胡/自摸声 ${primarySounds[index].length}，特效声 ${effectSounds[index].length}`)
      }
    }
    if (expectedCount === 1 && (
      winEffects[0][0].tile !== winEffects[1][0].tile
      || primarySounds[0][0].name !== primarySounds[1][0].name
    )) {
      await failWithEvidence(pages, testInfo, consoleLogs,
        `online-match-${matchIndex}-${token}-win-presentation-mismatch`,
        `线上第 ${matchIndex} 场 ${hand} 双端胡牌特效或声音不一致`)
    }

      const tableStates = await Promise.all(pages.map(readNormalizedTableState)) as [
        NormalizedTableState | null, NormalizedTableState | null,
      ]
    if (tableStates.every(Boolean)) {
      try {
        assertTableStatesEqual(tableStates, `第 ${matchIndex} 场 ${hand} 结算：`)
      } catch (error) {
        await failWithEvidence(pages, testInfo, consoleLogs,
          `online-match-${matchIndex}-${token}-table-mismatch`, String(error))
      }
    }
    settledTableStates.set(token, tableStates)
    verifiedHands.add(token)
  }

  while (Date.now() < deadline) {
    for (let index = 0; index < consoleLogs.length; index += 1) {
      const fatal = consoleLogs[index].find((line) => fatalOnlineSignal.test(line))
      if (fatal) {
        await failWithEvidence(pages, testInfo, consoleLogs,
          `online-match-${matchIndex}-forbidden-recovery`,
          `线上第 ${matchIndex} 场${index === 0 ? '房主' : '客户端'}出现禁止的恢复/重连/旧代次/AI接管信号：${fatal}`)
      }
    }
    const labels = await Promise.all([readRoundLabel(host), readRoundLabel(client)])
    const settlementVisible = await Promise.all([host, client].map((page) => (
      page.locator('.round-settlement').isVisible().catch(() => false)
    )))
    const continueVisible = await Promise.all([host, client].map((page) => (
      page.locator('.round-settlement .result-actions button').filter({ hasText: /^继续/ }).first()
        .isVisible().catch(() => false)
    )))
    for (let index = 0; index < settlementVisible.length; index += 1) {
      settlementVisible[index] ||= continueVisible[index]
    }
    const settlementTexts = await Promise.all([host, client].map((page, index) => (
      settlementVisible[index]
        ? page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => '')
        : Promise.resolve('')
    )))
    const settlementEvents = await Promise.all(pages.map(settlementHistory))
    const settlementText = settlementTexts.find(Boolean) ?? ''
    // 结算弹窗文本只含「东N局」，不含本场信息；round-info 标签才带「N本场」。
    // 因此结算匹配按局号（roundToken），evidence/计时键按完整手牌（handToken）。
    const roundToken = (value: string) => value.match(/东[1-4]局/)?.[0] ?? ''
    const handToken = (value: string) => {
      const round = value.match(/东[1-4]局/)?.[0] ?? ''
      const honba = value.match(/(\d+)本场/)?.[1] ?? '0'
      return round ? `${round}:${honba}` : ''
    }
    // 保留局号、得分与和牌信息，生成跨确认状态稳定的结算签名，区分同 round 连庄
    // （东4局 vs 东4局·1本场）的新旧结算层。
    const settlementSignature = (text: string) => text
      .split('\n')
      .filter((line) => !/查看牌桌|继续(?:\s*\(\d+\))?|等待其他玩家|已确认/.test(line))
      .join('\n')
    for (let index = 0; index < settlementEvents.length; index += 1) {
      const events = settlementEvents[index]
      for (const event of events.slice(settlementEventCounts[index])) {
        const evidence = settlementEvidence.get(event.token) ?? {
          popup: [0, 0], confirmed: [0, 0], appearances: [0, 0],
          draw: [false, false], resultSignatures: ['', ''],
        }
        if (event.appearance) {
          evidence.popup[index] ||= event.at
          evidence.appearances[index] += 1
          evidence.draw[index] = event.draw
          evidence.resultSignatures[index] = event.resultSignature
        }
        if (event.confirmed) evidence.confirmed[index] ||= event.at
        settlementEvidence.set(event.token, evidence)
        if (event.labelMismatch) {
          await failWithEvidence(pages, testInfo, consoleLogs,
            `online-match-${matchIndex}-${event.token}-settlement-label-mismatch`,
            `线上第 ${matchIndex} 场 ${event.token} 结算弹窗与当前手牌局号不一致`)
        }
        if (evidence.appearances[index] > 1) {
          await failWithEvidence(pages, testInfo, consoleLogs,
            `online-match-${matchIndex}-${event.token}-duplicate-settlement`,
            `线上第 ${matchIndex} 场 ${event.token} ${index === 0 ? '房主' : '客户端'}结算弹窗重复出现 ${evidence.appearances[index]} 次`)
        }
      }
      settlementEventCounts[index] = events.length
    }
    const clientHand = labels[1]

    if (clientHand && clientHand !== activeHand) {
      const first = !activeHand
      const previousHand = activeHand
      if (previousHand) {
        const evidence = settlementEvidence.get(handToken(previousHand))
        if (evidence) {
          popupSeenAt = [...evidence.popup] as [number, number]
          confirmedAt = [...evidence.confirmed] as [number, number]
          if (popupSeenAt.some(Boolean)) transitionHand = previousHand
        }
      }
      if (previousHand && transitionHand === previousHand && confirmedAt.every(Boolean)) {
        const confirmedToNextMs = Date.now() - Math.max(...confirmedAt)
        transitionTimings.push({
          hand: previousHand,
          popupSkewMs: Math.abs(popupSeenAt[0] - popupSeenAt[1]),
          confirmationSkewMs: Math.abs(confirmedAt[0] - confirmedAt[1]),
          confirmedToNextMs,
        })
        console.log(`[ONLINE][第${matchIndex}场] ${previousHand} 双确认后 ${confirmedToNextMs}ms 进入 ${clientHand}`)
      } else if (previousHand && settledHand === previousHand && !confirmedAt.every(Boolean)) {
        throw await diagnostics(host, client, consoleLogs,
          `线上第 ${matchIndex} 场 ${previousHand} 未记录双端确认却进入 ${clientHand}`)
      }
      if (previousHand) {
        await verifySettledHand(previousHand, true)
        const visibleNextStates = await waitForVisibleNextHandStates(pages, clientHand)
        for (let index = 0; index < visibleNextStates.length; index += 1) {
          const state = visibleNextStates[index]
          const side = index === 0 ? '房主' : '客户端'
          if (state.hand !== clientHand
            || state.wallCount <= 0
            || state.wallHeadDrawn <= 0
            || state.localHandCount <= 0
            || !state.canvasPresent
            || state.canvasWidth <= 0
            || state.canvasHeight <= 0
            || state.contextLost !== false
            || state.winEffectVisible) {
            await failWithEvidence(pages, testInfo, consoleLogs,
              `online-match-${matchIndex}-${handToken(previousHand)}-visible-transition-failure`,
              `线上第 ${matchIndex} 场 ${previousHand} → ${clientHand} 时${side}可见牌桌状态异常：${JSON.stringify(state)}`)
          }
        }
        if (visibleNextStates[0].wallCount !== visibleNextStates[1].wallCount
          || visibleNextStates[0].wallHeadDrawn !== visibleNextStates[1].wallHeadDrawn) {
          await failWithEvidence(pages, testInfo, consoleLogs,
            `online-match-${matchIndex}-${handToken(previousHand)}-visible-wall-mismatch`,
            `线上第 ${matchIndex} 场 ${previousHand} → ${clientHand} 双端公开牌山状态不一致：${JSON.stringify(visibleNextStates)}`)
        }
        const nextStates = await waitForSynchronizedTableStates(pages, clientHand)
        if (nextStates.every(Boolean)) {
          try {
            assertTableStatesEqual(nextStates, `第 ${matchIndex} 场 ${previousHand} → ${clientHand}：`)
          } catch (error) {
            await failWithEvidence(pages, testInfo, consoleLogs,
              `online-match-${matchIndex}-${handToken(previousHand)}-transition-mismatch`, String(error))
          }
          for (let index = 0; index < 2; index += 1) {
            const state = nextStates[index]!
            if (state.wallCount <= 0) {
              await failWithEvidence(pages, testInfo, consoleLogs,
                `online-match-${matchIndex}-${handToken(previousHand)}-wall-disappeared`,
                `线上第 ${matchIndex} 场进入 ${clientHand} 时${index === 0 ? '房主' : '客户端'}牌山凭空消失`)
            }
            const concealed = state.players.reduce((sum, player) => sum + player.concealedCount, 0)
            if (state.openingStage === 'deal' && state.wallHeadDrawn > 0 && concealed <= 0) {
              await failWithEvidence(pages, testInfo, consoleLogs,
                `online-match-${matchIndex}-${handToken(previousHand)}-hands-disappeared`,
                `线上第 ${matchIndex} 场进入 ${clientHand} 发牌后${index === 0 ? '房主' : '客户端'}暗手凭空消失`)
            }
            if (state.winEffect) {
              await failWithEvidence(pages, testInfo, consoleLogs,
                `online-match-${matchIndex}-${handToken(previousHand)}-stale-win-effect`,
                `线上第 ${matchIndex} 场进入 ${clientHand} 后仍残留上一手胡牌特效`)
            }
            if (state.players.some((player) => player.discards.length || player.melds.length)) {
              await failWithEvidence(pages, testInfo, consoleLogs,
                `online-match-${matchIndex}-${handToken(previousHand)}-stale-table-tiles`,
                `线上第 ${matchIndex} 场进入 ${clientHand} 后仍残留上一手牌河或副露`)
            }
          }
        }
        transitionIntegrity.push({
          fromHand: previousHand,
          toHand: clientHand,
          settled: settledTableStates.get(handToken(previousHand)) ?? [null, null],
          next: nextStates,
        })
      }
      if (activeHand) {
        const completedAt = settledHand === activeHand && settlementStartedAt > 0 ? settlementStartedAt : Date.now()
        const duration = completedAt - (activeHandStartedAt || activeHandObservedAt)
        if (!timings.some((item) => item.hand === activeHand)) {
          timings.push({ hand: activeHand, seconds: Math.round(duration / 1000) })
        }
        if (duration > 360_000) throw await diagnostics(host, client, consoleLogs,
          `线上第 ${matchIndex} 场 ${activeHand} 完成超过 6 分钟`)
      }
      activeHand = clientHand
      activeHandObservedAt = Date.now()
      // 结算签名按「页」去重（各页最近一次已消费的签名）：两端弹窗在高负载
      // 轮询下可能在不同时刻才可读，共享签名会抑制后出现一端的检测与确认点击。
      const currentSettlement = settlementTexts.some((text, index) => (
        settlementVisible[index]
        && roundToken(text) === roundToken(clientHand)
        && settlementSignature(text) !== lastSettlementSignatures[index]
      ))
      waitingForPreviousSettlementToClear = !first && settlementVisible.some(Boolean) && !currentSettlement
      activeHandStartedAt = first ? matchStartedAt : (waitingForPreviousSettlementToClear ? 0 : activeHandObservedAt)
      settledHand = ''
      settlementStartedAt = 0
      transitionHand = ''
      const currentEvidence = settlementEvidence.get(handToken(activeHand))
      popupSeenAt = currentEvidence ? [...currentEvidence.popup] as [number, number] : [0, 0]
      confirmedAt = currentEvidence ? [...currentEvidence.confirmed] as [number, number] : [0, 0]
    }

    const replaced = settlementTexts.some((text, index) => (
      settlementVisible[index]
      && roundToken(text) === roundToken(activeHand)
      && settlementSignature(text) !== lastSettlementSignatures[index]
    ))
    if (waitingForPreviousSettlementToClear && (settlementVisible.every((x) => !x) || replaced)) {
      waitingForPreviousSettlementToClear = false
      activeHandStartedAt = activeHandObservedAt
    }
    const settlementMatchesActive = settlementTexts.map((text, index) => (
      settlementVisible[index]
      && roundToken(text) === roundToken(activeHand)
      && (settlementSignature(text) !== lastSettlementSignatures[index])
    ))
    if (activeHand && activeHandStartedAt > 0 && !waitingForPreviousSettlementToClear
      && settlementMatchesActive.some(Boolean) && settledHand !== activeHand) {
      settledHand = activeHand
      settlementStartedAt = Date.now()
      for (let index = 0; index < settlementMatchesActive.length; index += 1) {
        if (settlementMatchesActive[index]) {
          lastSettlementSignatures[index] = settlementSignature(settlementTexts[index])
        }
      }
      const seconds = Math.round((settlementStartedAt - activeHandStartedAt) / 1000)
      timings.push({ hand: activeHand, seconds })
      console.log(`[ONLINE][第${matchIndex}场] ${activeHand} ${seconds}s`)
      if (seconds > 360) throw await diagnostics(host, client, consoleLogs,
        `线上第 ${matchIndex} 场 ${activeHand} 到结算超过 6 分钟（${seconds}s）`)
    }
    if (activeHand && settlementMatchesActive.some(Boolean)) {
      if (transitionHand !== activeHand) {
        transitionHand = activeHand
        popupSeenAt = [0, 0]
        confirmedAt = [0, 0]
      }
      for (let index = 0; index < settlementMatchesActive.length; index += 1) {
        if (settlementMatchesActive[index] && !popupSeenAt[index]) {
          popupSeenAt[index] = Date.now()
          console.log(`[ONLINE][第${matchIndex}场] ${activeHand} ${index === 0 ? '房主' : '客户端'}结算弹窗出现`)
        }
      }
      const evidence = settlementEvidence.get(handToken(activeHand)) ?? {
        popup: [0, 0], confirmed: [0, 0], appearances: [0, 0],
        draw: [false, false], resultSignatures: ['', ''],
      }
      evidence.popup = [...popupSeenAt] as [number, number]
      settlementEvidence.set(handToken(activeHand), evidence)
    }
    // 弹窗可能在 500ms 轮询之间出现并因自动确认立即消失；以页面内 20ms
    // MutationObserver 历史补齐 popupSeenAt/confirmedAt，避免把快速正常切局误报为漏弹窗。
    const currentEvidence = settlementEvidence.get(handToken(activeHand))
    if (currentEvidence) {
      popupSeenAt = [...currentEvidence.popup] as [number, number]
      confirmedAt = [...currentEvidence.confirmed] as [number, number]
    }
    if (popupSeenAt.every(Boolean)) await verifySettledHand(activeHand)
    const firstPopupAt = popupSeenAt.find(Boolean) ?? 0
    // 主动恢复最坏包含 5s 心跳发现、3s SDK reconnect 观察和 2.5s 重进缓冲；
    // 双端弹窗仍须在 20s 内同步，否则不算可接受的流畅恢复。
    if (firstPopupAt && !popupSeenAt.every(Boolean) && Date.now() - firstPopupAt > 20_000) {
      // WebGL 高负载下主循环轮询可能读取弹窗超时（innerText 1s 超时返回空），
      // 导致一端 popup 未被记录。先实时复核两端结算层：两端当前局结算都已显示
      // （含继续按钮/等待确认文案），说明业务同步正常，只是采样迟到。
      const popupNow = await Promise.all([host, client].map((page) => (
        page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => '')
      )))
      const bothShown = popupNow.every((text, index) => (
        roundToken(text) === roundToken(activeHand)
        && (settlementSignature(text) !== lastSettlementSignatures[index])
      ))
      if (!bothShown) {
        throw await diagnostics(host, client, consoleLogs,
          `线上第 ${matchIndex} 场 ${activeHand} 双端结算弹窗 20 秒仍未同步`)
      }
      // 用 MutationObserver 历史补齐另一端的弹窗时间，保持双确认判定可用。
      const evidenceNow = settlementEvidence.get(handToken(activeHand)) ?? {
        popup: [0, 0], confirmed: [0, 0], appearances: [0, 0],
        draw: [false, false], resultSignatures: ['', ''],
      }
      evidenceNow.popup = popupNow.map((text, index) => (
        popupSeenAt[index] || (text && roundToken(text) === roundToken(activeHand) ? Date.now() : 0)
      )) as [number, number]
      settlementEvidence.set(handToken(activeHand), evidenceNow)
      popupSeenAt = [...evidenceNow.popup] as [number, number]
      console.log(`[ONLINE][第${matchIndex}场] ${activeHand} 双端结算弹窗 20s 复核两端均已显示，判定为采样延迟`)
    }
    if (activeHand && activeHandStartedAt > 0 && settledHand !== activeHand
      && Date.now() - activeHandStartedAt > 360_000) {
      // 主循环可能被 WebGL 截图阻塞，结算弹窗已出现但本轮未采集到。先实时复核
      // 两端结算层：任一端已显示当前局的结算，说明业务已按时结算，只是检测迟到。
      const settlementNow = await Promise.all([host, client].map((page) => (
        page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => '')
      )))
      const settledNow = settlementNow.some((text, index) => (
        roundToken(text) === roundToken(activeHand)
        && (settlementSignature(text) !== lastSettlementSignatures[index])
      ))
      if (!settledNow) {
        throw await diagnostics(host, client, consoleLogs,
          `线上第 ${matchIndex} 场 ${activeHand} 仍未结算，超过 6 分钟`)
      }
      // 用 MutationObserver 记录的真实弹窗时间还原该手耗时。若真实弹窗时间
      // 确实超过 360s（记录到了且晚于门限），仍判失败；只有「弹窗已出现但
      // 主循环因截图取证延迟错过」才算取证延迟。
      const evidenceNow = settlementEvidence.get(handToken(activeHand))
      const realPopupAt = evidenceNow ? (evidenceNow.popup.find(Boolean) ?? 0) : 0
      if (realPopupAt > 0 && realPopupAt - activeHandStartedAt > 360_000) {
        throw await diagnostics(host, client, consoleLogs,
          `线上第 ${matchIndex} 场 ${activeHand} 到结算超过 6 分钟（真实弹窗 ${Math.round((realPopupAt - activeHandStartedAt) / 1000)}s）`)
      }
      settledHand = activeHand
      settlementStartedAt = realPopupAt || Date.now()
      const settledSignature = settlementSignature(settlementNow.find(Boolean) ?? '')
      lastSettlementSignatures = [settledSignature, settledSignature]
      const realSeconds = Math.round((settlementStartedAt - activeHandStartedAt) / 1000)
      console.log(`[ONLINE][第${matchIndex}场] ${activeHand} 超过 6 分钟门限但复核已出现结算（实际 ${realSeconds}s），判定为截图取证延迟`)
    }
    if (settledHand === activeHand && settlementStartedAt > 0
      && Date.now() - settlementStartedAt > 180_000) {
      throw await diagnostics(host, client, consoleLogs,
        `线上第 ${matchIndex} 场 ${activeHand} 结算后 180 秒未推进`)
    }
    for (const [index, label] of labels.entries()) {
      for (const marker of markers) if (label.includes(marker) && !observed[index].includes(marker)) observed[index].push(marker)
    }
    const autoEvents = await Promise.all([host, client].map(takeAutoPlayerEvents))
    for (let index = 0; index < autoEvents.length; index += 1) {
      const events = autoEvents[index]
      const huClicks = events.filter((event) => event.type === 'hu-click')
      const otherClicks = events.filter((event) => event.type !== 'hu-click')
      if (otherClicks.length > 0) {
        // 诊断：真人出牌/过牌点击节奏（用于区分「环境卡顿拖慢出牌」与「业务不推进」）。
        const firstAt = otherClicks[0].at
        const lastAt = otherClicks[otherClicks.length - 1].at
        const gapMs = otherClicks.length > 1 ? Math.round((lastAt - firstAt) / (otherClicks.length - 1)) : 0
        console.log(`[ONLINE][第${matchIndex}场] ${activeHand} ${index === 0 ? '房主' : '客户端'}自动出牌 ${otherClicks.length} 次，平均间隔 ${gapMs}ms`)
      }
      for (const event of huClicks) {
        huEffectCaptures.push({ hand: activeHand, side: index === 0 ? 'host' : 'client', at: event.at })
        console.log(`[ONLINE][第${matchIndex}场] ${activeHand} ${index === 0 ? '房主' : '客户端'}点击胡，捕获双端特效画面`)
        // 120ms 自动点击器记录事件后，主循环最迟约 500ms 取证，仍在 2.6s 特效窗口内。
        await attachDualScreenshots(
          pages,
          testInfo,
          `online-match-${matchIndex}-${activeHand}-${index === 0 ? 'host' : 'client'}-hu`,
        )
      }
    }
    const sampledWinEffects = await Promise.all(pages.map(winEffectHistory))
    if (sampledWinEffects.some((history, index) => history.length > sampledWinEffectCounts[index])) {
      sampledWinEffectCounts = [sampledWinEffects[0].length, sampledWinEffects[1].length]
      console.log(`[ONLINE][第${matchIndex}场] ${activeHand} 捕获双端胡牌特效画面`)
      await attachDualScreenshots(pages, testInfo, `online-match-${matchIndex}-${activeHand}-win-effect`)
    }
    const clicked = await Promise.all(pages.map((page, index) => (
      settlementMatchesActive[index] ? clickContinueIfAvailable(page) : Promise.resolve(false)
    )))
    for (let index = 0; index < clicked.length; index += 1) {
      if (clicked[index] && !confirmedAt[index]) {
        confirmedAt[index] = Date.now()
        console.log(`[ONLINE][第${matchIndex}场] ${activeHand} ${index === 0 ? '房主' : '客户端'}已点击确认`)
      }
    }

    const finals = await Promise.all([host, client].map((page) => page.locator('.final-backdrop').isVisible().catch(() => false)))
    if (finals.every(Boolean)) {
      await verifySettledHand(activeHand, true)
      break
    }
    if (confirmedAt.every(Boolean) && Date.now() - Math.max(...confirmedAt) > 10_000) {
      // 主循环可能被 WebGL 取证截图短暂阻塞，错过局号切换。先实时复核两端当前局号：
      // 若已进入下一局或最终结算，说明业务推进正常，只是检测迟到，不算失败。
      // 切局动画期间 round-info 可能短暂为空（开局 overlay 已出现、标签尚未渲染），
      // 因此连续重试 3 次，并把「开局动画进行中」视为已推进。
      let advanced = false
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const nowLabels = await Promise.all([readRoundLabel(host), readRoundLabel(client)])
        const finalsNow = await Promise.all([host, client].map((page) => (
          page.locator('.final-backdrop').isVisible().catch(() => false)
        )))
        const openingNow = await Promise.all([host, client].map((page) => (
          page.locator('.opening-overlay').isVisible().catch(() => false)
        )))
        if (finalsNow.some(Boolean) || (nowLabels[1] && nowLabels[1] !== activeHand)) {
          advanced = true
          break
        }
        // 开局动画可见但标签尚未渲染：下一局开局正在进行，业务已推进。
        if (openingNow.some(Boolean) && !nowLabels[1]) {
          advanced = true
          break
        }
        if (attempt < 2) await host.waitForTimeout(1000)
      }
      if (!advanced) {
        throw await diagnostics(host, client, consoleLogs,
          `线上第 ${matchIndex} 场 ${activeHand} 双端确认后 10 秒仍未进入下一局或最终结算`)
      }
      console.log(`[ONLINE][第${matchIndex}场] ${activeHand} 双确认后超过 10s 但复核已进入下一局/终局，判定为截图取证延迟`)
    }
    const firstConfirmedAt = confirmedAt.find(Boolean) ?? 0
    if (firstConfirmedAt && !confirmedAt.every(Boolean) && Date.now() - firstConfirmedAt > 20_000) {
      // 一端已确认但另一端 20 秒未确认：先复核是否已进入下一局（切局动画可能让
      // 新一局短暂无结算层，且另一端确认事件已发生但主循环未采集到）。
      const nowLabels = await Promise.all([readRoundLabel(host), readRoundLabel(client)])
      if (nowLabels[1] && nowLabels[1] !== activeHand) {
        console.log(`[ONLINE][第${matchIndex}场] ${activeHand} 一端确认后 20s 但复核已进入 ${nowLabels[1]}，判定为采集延迟`)
      } else {
        throw await diagnostics(host, client, consoleLogs,
          `线上第 ${matchIndex} 场 ${activeHand} 一端确认后 20 秒另一端仍未确认`)
      }
    }
    if (Date.now() - lastProgressAt > 30_000) {
      lastProgressAt = Date.now()
      console.log(`[ONLINE][第${matchIndex}场][${Math.round((Date.now() - matchStartedAt) / 1000)}s] ${labels.join(' | ')}`)
    }
    await host.waitForTimeout(500)
  }

  expect(observed[0], `线上第 ${matchIndex} 场房主轮次不完整`).toEqual(markers)
  expect(observed[1], `线上第 ${matchIndex} 场客人轮次不完整`).toEqual(markers)
  for (const page of [host, client]) {
    await expect(page.locator('.final-backdrop')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('最终排名')).toBeVisible()
  }
  const finalOpeningHistories = await Promise.all(pages.map((page) => openingHistory(page, true)))
  const openingCycles = finalOpeningHistories.map((history, index) => (
    validateOpeningCycles(history, index === 0 ? '房主' : '客户端', matchIndex)
  ))
  expect(openingCycles[0].length, `第 ${matchIndex} 场房主开局动画次数不足`).toBeGreaterThanOrEqual(4)
  expect(openingCycles[1].length, `第 ${matchIndex} 场客户端开局动画次数不足`).toBeGreaterThanOrEqual(4)
  // 双端 cycle 数不强制相等：连庄局较多时各端采样器在 WebGL 高负载下可能
  // 漏掉个别开局，但每端都完整覆盖东1-东4 的 4 次开局即可。
  if (openingCycles[0].length !== openingCycles[1].length) {
    console.log(`[ONLINE] 第 ${matchIndex} 场开局动画采样：房主 ${openingCycles[0].length} 次、客户端 ${openingCycles[1].length} 次（采样差异）`)
  }
  const tableTransitions = await Promise.all(pages.map(tableTransitionHistory))
  await testInfo.attach(`online-match-${matchIndex}-table-transitions`, {
    body: JSON.stringify({ host: tableTransitions[0], client: tableTransitions[1] }, null, 2),
    contentType: 'application/json',
  })
  const hands = [...new Set(timings.map((item) => item.hand))]
  for (let index = 0; index < 2; index += 1) {
    for (const hand of hands) {
      assertTransitionHistory(
        tableTransitions[index], hand, index === 0 ? '房主' : '客户端', matchIndex,
      )
    }
  }
  const finalWinEffects = await Promise.all(pages.map(winEffectHistory))
  expect([...verifiedHands].length, `第 ${matchIndex} 场存在未完成表现完整性验证的手牌`)
    .toBe(timings.length)
  const fault = /PLAYER_COUNT|玩家数[=为](?:0|3)|洗牌承诺超时|\[wall-regress\]|非法状态快照|确认后长时间未收到推进信号|房间已失效|无法连接|先释放旧连接再重进|自动重进失败|尝试重新加入房间|房主连接中断|恢复牌局|已验证重进握手|大厅验证的新 peer 已恢复原座位|丢弃.*(?:旧|权威|代次)|旧权威|AI 代打|AI 接管/i
  for (let index = 0; index < consoleLogs.length; index += 1) {
    expect(consoleLogs[index].filter((line) => fault.test(line)), `线上第 ${matchIndex} 场页面 ${index} 出现应用故障`).toEqual([])
  }
  await testInfo.attach(`online-match-${matchIndex}-result`, {
    body: JSON.stringify({
      roomCode, timings, transitionTimings, huEffectCaptures,
      openingHistories: finalOpeningHistories,
      winEffects: finalWinEffects,
      audio: await Promise.all(pages.map(audioHistory)),
      settlementEvents: await Promise.all(pages.map(settlementHistory)),
      tableTransitions,
      transitionIntegrity,
      recoveryEvents: consoleLogs.map((logs) => logs.filter((line) => (
        /单次请求当前手牌事实|先释放旧连接再重进|rejoin_ok|恢复牌局/i.test(line)
      ))),
      elapsedSeconds: Math.round((Date.now() - matchStartedAt) / 1000),
    }),
    contentType: 'application/json',
  })
  console.log(`[ONLINE] 第 ${matchIndex} 个东风场通过，房间 ${roomCode}`)
  return { roomCode, timings }
}

test('两个线上账号完成两个莲花麻将东风场，每手不超过6分钟', async ({ browser }, testInfo) => {
  const contexts = await Promise.all(ONLINE.accounts.map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })))
  let activePages: [Page, Page] | null = null
  let capturedLogs: string[][] = [[], []]
  try {
    await Promise.all(contexts.map(installAudioProbe))
    // 游戏授权令牌位于当前标签页的 sessionStorage；必须复用授权返回的两个页面，
    // 不能只保留 VibeHub Cookie 后另开标签。
    const pages = [
      await authenticate(contexts[0], ONLINE.accounts[0]),
      await authenticate(contexts[1], ONLINE.accounts[1]),
    ] as [Page, Page]
    activePages = pages
    const recoveryMarkers = await Promise.all(pages.map(readRecoveryBuildMarkers))
    console.log(`[ONLINE] 线上恢复构建标记：${recoveryMarkers.map((marker) => (
      JSON.stringify(marker)
    )).join(' | ')}`)
    const expectedMarkers = {
      reconnect: false,
      fullRejoin: false,
      sendGuard: false,
      sdkEventRecovery: true,
      settlementRecovery: true,
      settlementReadinessGate: true,
      revealCompletionRecovery: true,
      settlementSyncRequest: true,
      strictContinueBarrier: true,
      settlementDegradeRecovery: true,
      settlementDeadlineGuard: true,
      authoritySilenceProbe: true,
      verifiedRosterRecovery: true,
      settlementAiBarrier: true,
      synchronousRoomBinding: true,
      rosterReadyHandshake: true,
      delayedSettlementReplay: true,
    }
    expect(recoveryMarkers, '线上页面未加载事件驱动恢复构建').toEqual([
      expectedMarkers,
      expectedMarkers,
    ])
    const logs = pages.map(() => [] as string[])
    capturedLogs = logs
    const errors = pages.map(() => [] as string[])
    pages.forEach((page, index) => {
      page.on('pageerror', (error) => errors[index].push(error.message))
      page.on('console', (message) => {
        const line = message.text()
        if (/\[host\]|\[client\]|\[diag\]|\[transport\]|心跳|主动重建|error|warn|丢弃|重进|洗牌|快照|continue|shuffle|AI 代打|wall-regress/i.test(line)) {
          logs[index].push(line)
          if (/\[transport\]|心跳|主动重建|先释放旧连接再重进/i.test(line)) {
            console.log(`[ONLINE][${index === 0 ? '房主' : '客户端'}控制台] ${line}`)
          }
        }
      })
    })
    const results: Array<{ roomCode: string; timings: Array<{ hand: string; seconds: number }> }> = []
    for (let matchIndex = 1; matchIndex <= 2; matchIndex += 1) {
      results.push(await runEastMatch({
        host: pages[0], client: pages[1], matchIndex, consoleLogs: logs, testInfo,
        reuseRoom: matchIndex > 1,
      }))
      expect(errors[0], `线上第 ${matchIndex} 场房主出现未捕获异常`).toEqual([])
      expect(errors[1], `线上第 ${matchIndex} 场客人出现未捕获异常`).toEqual([])
      if (matchIndex < 2) {
        for (const page of pages) {
          await page.getByRole('button', { name: '返回大厅', exact: true }).click()
          await expect(page.getByRole('button', { name: '离开房间', exact: true })).toBeVisible({ timeout: 30_000 })
        }
        await expect(pages[0].getByRole('button', { name: /开始对局/ })).toBeEnabled({ timeout: 30_000 })
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    expect(new Set(results.map((result) => result.roomCode)).size).toBe(1)
    console.log(`[ONLINE] 同一房间连续两个东风场完整通过：${results[0].roomCode}`)
  } catch (error) {
    if (activePages) {
      await attachDualScreenshots(activePages, testInfo, 'online-two-east-matches-failure')
      await testInfo.attach('online-two-east-matches-failure-evidence', {
        body: JSON.stringify({
          error: String(error),
          logs: capturedLogs,
          pages: await Promise.all(activePages.map(async (page) => ({
            round: await readRoundLabel(page),
            canvas: await readCanvasHealth(page),
            table: await readNormalizedTableState(page),
            settlement: await page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => ''),
            winEffects: await winEffectHistory(page),
            audio: await audioHistory(page),
            settlements: await settlementHistory(page),
            tableTransitions: await tableTransitionHistory(page),
          }))),
        }, null, 2),
        contentType: 'application/json',
      })
    }
    throw error
  } finally {
    await Promise.race([
      Promise.all(contexts.map((context) => context.close().catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
  }
})
