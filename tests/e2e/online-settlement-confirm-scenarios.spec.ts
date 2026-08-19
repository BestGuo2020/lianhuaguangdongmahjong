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
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

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

function readOnlineConfig(): OnlineConfig {
  const raw = readFileSync('tmp/online_test', 'utf8')
  const url = raw.match(/测试 url：([^\r\n]+)/)?.[1]?.trim()
  const accounts = [...raw.matchAll(/账号\d+：([^，\r\n]+)，密码：([^\r\n]+)/g)]
    .map((match) => ({ email: match[1].trim(), password: match[2].trim() }))
  if (!url || accounts.length < 2) throw new Error('tmp/online_test 缺少测试 URL 或两个账号')
  return { url, accounts: [accounts[0], accounts[1]] }
}

const ONLINE = readOnlineConfig()
test.setTimeout(12_000_000)

async function selectOnlineMode(page: Page) {
  await page.getByText('联机对战', { exact: false }).first().click()
}

async function authenticate(context: BrowserContext, account: Account, manual: boolean) {
  const page = await context.newPage()
  const separator = ONLINE.url.includes('?') ? '&' : '?'
  const params = new URLSearchParams()
  // manualContinue=1 关闭生产默认的 10 秒自动确认；场景 A 不带该参数保留默认行为。
  if (manual) params.set('manualContinue', '1')
  await page.goto(`${ONLINE.url}${separator}${params}`, {
    waitUntil: 'domcontentloaded', timeout: 90_000,
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
  let authorized = false
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline && !authorized) {
    const authorize = popup.getByRole('button', { name: '同意并进入游戏', exact: true })
    if (await authorize.isVisible().catch(() => false)) {
      await authorize.click()
      authorized = true
      break
    }
    const email = popup.locator('input[name=email]')
    if (await email.isVisible().catch(() => false)) {
      lastAuthProgressAt = Date.now()
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
      const goLogin = popup.getByRole('button', { name: '去登录', exact: true })
      if (await goLogin.isVisible().catch(() => false)) {
        await goLogin.click()
        lastAuthProgressAt = Date.now()
      } else if (Date.now() - lastAuthProgressAt > 20_000 && loadingReloads < 3) {
        await popup.close().catch(() => {})
        popup = await openAuthPopup()
        loadingReloads += 1
        submitted = false
        lastAuthProgressAt = Date.now()
      }
    }
    await popup.waitForTimeout(400)
  }
  if (!authorized) throw new Error('VibeHub 登录/授权在 180 秒内未完成')
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

/** 等待下一手（handKey 变化）出现：用于自动确认/补点确认后的推进判定。 */
async function waitForNextHand(host: Page, client: Page, currentKey: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let hostLabel = await readRoundLabel(host)
  let clientLabel = await readRoundLabel(client)
  while (Date.now() < deadline) {
    hostLabel = await readRoundLabel(host)
    clientLabel = await readRoundLabel(client)
    if (hostLabel && handKey(hostLabel) !== currentKey
      && clientLabel && handKey(clientLabel) !== currentKey) {
      return { hostLabel, clientLabel }
    }
    await host.waitForTimeout(500)
  }
  throw new Error(`等待离开 ${currentKey} 超时（host=${hostLabel || '(空)'} client=${clientLabel || '(空)'}）`)
}

/**
 * 房间搭建韧性：等待双端出现「准备」按钮且各自座位列表 ≥2。
 * VibeHub 大厅 roster 同步偶发失败（客户端已入房但座位列表未更新）。
 * 座位 30 秒无进展时客户端「离开房间」后按原房间码重新加入（不刷新页面，
 * 刷新会丢失 VibeHub 登录态）；总预算 240 秒。
 */
async function waitForRoomReady(host: Page, client: Page, roomCode: string, nickname: string) {
  const deadline = Date.now() + 240_000
  let lastRejoinAt = 0
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
    if (Date.now() > deadline) break
    // 客户端已入房但座位 30 秒未同步：离开房间后重新加入同一房间。
    if (clientSeats < 2 && Date.now() - lastRejoinAt > 30_000) {
      lastRejoinAt = Date.now()
      console.log(`[确认专项] 客户端座位未同步（seats=${clientSeats} host=${hostSeats}），离开后重新加入 ${roomCode}`)
      const leave = client.getByRole('button', { name: '离开房间', exact: true })
      if (await leave.isVisible().catch(() => false)) {
        await leave.click().catch(() => {})
        await client.waitForTimeout(4_000)
      }
      try {
        await enterOnlineLobby(client, nickname, 'client')
        const join = client.getByRole('button', { name: '加入房间', exact: true })
        if (await join.isVisible().catch(() => false)) {
          await join.click()
          await client.getByPlaceholder('输入 6 位房间码').fill(roomCode)
          await client.getByRole('button', { name: '确认加入' }).click()
          await acceptDisclaimerIfShown(client)
        }
      } catch {
        // 重新加入流程异常（页面仍在加载/登录墙）时继续轮询，下一轮再评估。
      }
    }
    await host.waitForTimeout(2_000)
  }
  const hostLabel = await readRoundLabel(host)
  const clientLabel = await readRoundLabel(client)
  throw new Error(`等待房间就绪超时（room=${roomCode} hostReady=${hostReady} clientReady=${clientReady} hostSeats=${hostSeats} clientSeats=${clientSeats} hostLabel=${hostLabel || '(空)'} clientLabel=${clientLabel || '(空)'}）`)
}

/** 建房 → 双端入房 → 开局 → 自动打牌直到指定局结算。返回 roomCode。 */
async function startEastHandToSettlement(
  host: Page,
  client: Page,
  expectedKey: string,
  suffix: string,
): Promise<string> {
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
  await waitForRoomReady(host, client, roomCode, `确认专项客人-${suffix}`)
  await Promise.all([host, client].map(installHostAutoPlayer))
  // 开局前安装时序采样器：记录每局 136/断点0 → 一骰 → 翻精134 → 二骰 → 断点 → 发牌。
  await Promise.all([host, client].map(installOpeningSampler))
  const start = host.getByRole('button', { name: /开始对局/ })
  if (!await start.isEnabled().catch(() => false)) {
    await host.getByRole('button', { name: '准备 / 取消准备' }).click()
    await client.getByRole('button', { name: '准备 / 取消准备' }).click()
  }
  await expect(start).toBeEnabled({ timeout: 60_000 })
  await start.click()

  // 等开局完成进入东1局，随后自动打牌直到指定局结算。
  const handLabel = await waitForHand(host, '东1局:0', 120_000)
  expect(handLabel).toContain('东1局')
  console.log(`[确认专项] 房间 ${roomCode} 已进入 ${handLabel}，等待 ${expectedKey} 结算`)
  await waitForSettlement(host, client, expectedKey, 420_000)
  console.log(`[确认专项] 房间 ${roomCode} ${expectedKey} 双端结算弹窗已出现`)
  return roomCode
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
        else if (document.querySelector('.second-dice-note')) stage = 'second-dice-visible'
        else if (document.querySelector('.flip-indicator')) stage = 'flip-visible'
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

test('结算确认三场景：双端自动确认 / 仅房主确认 / 仅客户端确认', async ({ browser }, testInfo) => {
  const suffix = Date.now().toString(36).slice(-5)

  // ── 场景 A：双方都不确认 → 生产默认 10 秒自动确认 → 自动进入下一手 ──
  {
    const contexts = await Promise.all(ONLINE.accounts.map(() => (
      browser.newContext({ viewport: { width: 1280, height: 720 } })
    )))
    try {
      const pages = [
        await authenticate(contexts[0], ONLINE.accounts[0], false),
        await authenticate(contexts[1], ONLINE.accounts[1], false),
      ]
      const [host, client] = pages
      const hostLogs: string[] = []
      const clientLogs: string[] = []
      attachConsoleCapture(host, hostLogs)
      attachConsoleCapture(client, clientLogs)
      const roomCode = await startEastHandToSettlement(host, client, '东1局:0', `A-${suffix}`)
      const settledAt = Date.now()
      // 关键：两端都不点击确认；生产默认 10 秒倒计时应自动确认并进入下一手。
      console.log(`[确认专项][场景A] ${roomCode} 东1局结算，两端均不手动确认，等待自动确认`)
      const next = await waitForNextHand(host, client, '东1局:0', 60_000)
      const autoConfirmMs = Date.now() - settledAt
      console.log(`[确认专项][场景A] 自动确认耗时 ${autoConfirmMs}ms，进入 ${next.hostLabel} | ${next.clientLabel}`)

      // 验收 0：自动确认进入的新一局必须走完整开局时序
      // （136/断点0 → 一骰 → 翻精134 → 二骰 → 应用真实断点 → 分批发牌）。
      try {
        await verifyOpeningForHand(host, next.hostLabel, '房主', '场景A-东2局', testInfo)
        await verifyOpeningForHand(client, next.clientLabel, '客户端', '场景A-东2局', testInfo)
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

      // 验收 1：自动确认应在「10s 倒计时 + 切局/洗牌/开局」的合理窗口内（不是秒进/不是恢复）。
      expect(autoConfirmMs, `自动确认耗时 ${autoConfirmMs}ms 应处于合理窗口（10s 倒计时 + 切局开销）`)
        .toBeGreaterThan(8_000)
      expect(autoConfirmMs, `自动确认耗时 ${autoConfirmMs}ms 不应超过 60s`).toBeLessThan(60_000)

      // 验收 2：推进必须由自动确认倒计时驱动，不能有恢复/重进/静默等异常路径日志。
      const recoveryPattern = /先释放旧连接再重进|对局权威连续静默|单次请求当前手牌事实|升级为完整房间重进|心跳|房主长时间无响应/i
      const hostRecovery = hostLogs.filter((line) => recoveryPattern.test(line))
      const clientRecovery = clientLogs.filter((line) => recoveryPattern.test(line))
      await testInfo.attach('scenario-A-auto-confirm', {
        body: JSON.stringify({
          roomCode, autoConfirmMs,
          hostNext: next.hostLabel, clientNext: next.clientLabel,
          hostRecoveryLogs: hostRecovery.slice(-5),
          clientRecoveryLogs: clientRecovery.slice(-5),
        }),
        contentType: 'application/json',
      })
      expect(hostRecovery, `场景A 房主不应出现恢复/重进日志：${hostRecovery.join(' | ')}`).toEqual([])
      expect(clientRecovery, `场景A 客户端不应出现恢复/重进日志：${clientRecovery.join(' | ')}`).toEqual([])
      console.log(`[确认专项][场景A] 通过：自动确认 ${autoConfirmMs}ms 进入下一手，无恢复/重进日志`)
    } finally {
      await Promise.all(contexts.map((context) => context.close()))
    }
  }

  // ── 场景 B + C：带 manualContinue=1，验证单边确认不推进 ──
  {
    const manualContexts = await Promise.all(ONLINE.accounts.map(() => (
      browser.newContext({ viewport: { width: 1280, height: 720 } })
    )))
    try {
      const pages = [
        await authenticate(manualContexts[0], ONLINE.accounts[0], true),
        await authenticate(manualContexts[1], ONLINE.accounts[1], true),
      ]
      const [host, client] = pages
      const hostLogs: string[] = []
      const clientLogs: string[] = []
      attachConsoleCapture(host, hostLogs)
      attachConsoleCapture(client, clientLogs)

      // ── 场景 B：仅房主确认，客户端不确认 → 屏障阻止推进；客户端确认后进入下一手 ──
      {
        const roomCode = await startEastHandToSettlement(host, client, '东1局:0', `B-${suffix}`)
        const hostClicked = await clickContinue(host)
        expect(hostClicked, '房主应能点击继续').toBe(true)
        console.log(`[确认专项][场景B] ${roomCode} 仅房主确认，客户端不确认`)
        await assertBarrierHolds(host, client, '东1局:0', 25_000, hostLogs, testInfo, 'B-host-only')
        const clientClicked = await clickContinue(client)
        expect(clientClicked, '客户端补点继续').toBe(true)
        const next = await waitForNextHand(host, client, '东1局:0', 30_000)
        console.log(`[确认专项][场景B] 通过：屏障阻止单边推进，客户端确认后进入 ${next.hostLabel} | ${next.clientLabel}`)
        // 客户端确认后进入的新一局必须走完整开局时序。
        await verifyOpeningForHand(host, next.hostLabel, '房主', '场景B-下一手', testInfo)
        await verifyOpeningForHand(client, next.clientLabel, '客户端', '场景B-下一手', testInfo)
        await testInfo.attach('scenario-B-host-only-confirm', {
          body: JSON.stringify({ roomCode, hostNext: next.hostLabel, clientNext: next.clientLabel }),
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
        await waitForSettlement(host, client, currentKey, 420_000)
        console.log(`[确认专项][场景C] ${currentKey} 双端结算，仅客户端确认，房主不确认`)
        const clientClicked = await clickContinue(client)
        expect(clientClicked, '客户端应能点击继续').toBe(true)
        await assertBarrierHolds(host, client, currentKey, 25_000, hostLogs, testInfo, 'C-client-only')
        const hostClicked = await clickContinue(host)
        expect(hostClicked, '房主补点继续').toBe(true)
        const next = await waitForNextHand(host, client, currentKey, 40_000)
        console.log(`[确认专项][场景C] 通过：屏障阻止单边推进，房主确认后进入 ${next.hostLabel} | ${next.clientLabel}`)
        // 房主确认后进入的新一局必须走完整开局时序。
        await verifyOpeningForHand(host, next.hostLabel, '房主', '场景C-下一手', testInfo)
        await verifyOpeningForHand(client, next.clientLabel, '客户端', '场景C-下一手', testInfo)
        await testInfo.attach('scenario-C-client-only-confirm', {
          body: JSON.stringify({ hostNext: next.hostLabel, clientNext: next.clientLabel }),
          contentType: 'application/json',
        })
      }
    } finally {
      await Promise.all(manualContexts.map((context) => context.close()))
    }
  }

  console.log('[确认专项] 三场景全部通过')
})
