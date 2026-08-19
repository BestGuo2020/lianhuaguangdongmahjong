// 真实线上部署回归：凭据与 URL 只在运行时从 tmp/online_test 读取，绝不写入日志/附件。
// 两个 VibeHub 账号分别作为房主、客人；空余两席由引擎 AI 补齐，连续完成两个东风场。
import { readFileSync } from 'node:fs'
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

interface Account { email: string; password: string }
interface OnlineConfig { url: string; accounts: [Account, Account] }
interface AutoPlayerEvent { at: number; type: 'hu-click' }
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
  })
})

async function selectOnlineMode(page: Page) {
  await page.getByText('联机对战', { exact: false }).first().click()
}

async function authenticate(context: BrowserContext, account: Account, auto = false) {
  const page = await context.newPage()
  const separator = ONLINE.url.includes('?') ? '&' : '?'
  const params = new URLSearchParams({ manualContinue: '1' })
  if (auto) params.set('auto', '1')
  await page.goto(`${ONLINE.url}${separator}${params}`, {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  })
  await selectOnlineMode(page)
  if (await page.getByRole('button', { name: '创建房间', exact: true }).isVisible().catch(() => false)) {
    return page
  }

  const popupPromise = context.waitForEvent('page', { timeout: 30_000 })
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const popup = await popupPromise
  let submitted = false
  let submittedAt = 0
  let attempts = 0
  let authorized = false
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && !authorized) {
    const authorize = popup.getByRole('button', { name: '同意并进入游戏', exact: true })
    if (await authorize.isVisible().catch(() => false)) {
      await authorize.click()
      authorized = true
      break
    }
    const email = popup.locator('input[name=email]')
    if (await email.isVisible().catch(() => false)) {
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
      const goLogin = popup.getByRole('button', { name: '去登录', exact: true })
      if (await goLogin.isVisible().catch(() => false)) await goLogin.click()
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
        if (pass) { pass.click(); return }
      }
      document.querySelector<HTMLElement>('.hand-rack.playable .hand-tile-slot .mahjong-tile')?.click()
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
      __onlineOpeningSampler?: number
    }
    target.__onlineOpeningStages = []
    target.__onlineWinEffects = []
    let previous = '__unset__'
    let previousStage: string | null = null
    let previousWinEffectId: number | null = null
    let cycle = 0
    target.__onlineOpeningSampler = window.setInterval(() => {
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
      if (effectId != null && effectId !== previousWinEffectId) {
        previousWinEffectId = effectId
        target.__onlineWinEffects?.push({
          at: performance.now(),
          hand: document.querySelector('.round-info')?.textContent?.trim() ?? '',
          id: effectId,
          winnerIndex: typeof effect?.winnerIndex === 'number' ? effect.winnerIndex : -1,
          tile: typeof effect?.tile === 'string' ? effect.tile : '',
        })
      }
      // 生产构建不会暴露 Vue 内部 props，回退到用户实际可见的 DOM 阶段。
      if (stage == null) {
        if (document.querySelector('.opening-overlay.start-cue')) stage = 'start'
        else if (document.querySelector('.hand-rack.dealing')) stage = 'deal'
        else if (document.querySelector('.hand-tile-slot')) stage = 'deal'
        else if (document.querySelector('.second-dice-note')) stage = 'second-dice-visible'
        else if (document.querySelector('.flip-indicator')) stage = 'flip-visible'
      }
      if (stage === 'start' && previousStage !== 'start') cycle += 1
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
    }, 20)
  })
}

async function installSettlementSampler(page: Page) {
  await page.evaluate(() => {
    const target = window as unknown as {
      __onlineSettlementEvents?: Array<{ at: number; token: string; confirmed: boolean }>
      __onlineSettlementSampler?: number
    }
    target.__onlineSettlementEvents = []
    const roundToken = (value: string) => {
      const round = value.match(/东[1-4]局/)?.[0] ?? ''
      const honba = value.match(/(\d+)本场/)?.[1] ?? '0'
      return round ? `${round}:${honba}` : ''
    }
    let last = ''
    const sample = () => {
      const overlay = document.querySelector<HTMLElement>('.round-settlement')
      if (!overlay) return
      const text = overlay.innerText ?? ''
      const token = roundToken(text)
      if (!token) return
      const confirmed = /已确认|等待其他玩家确定/.test(text)
      const signature = `${token}|${confirmed}|${text}`
      if (signature === last) return
      last = signature
      target.__onlineSettlementEvents?.push({ at: Date.now(), token, confirmed })
    }
    target.__onlineSettlementSampler = window.setInterval(sample, 20)
    const observer = new MutationObserver(sample)
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    ;(target as { __onlineSettlementObserver?: MutationObserver }).__onlineSettlementObserver = observer
  })
}

async function settlementHistory(page: Page) {
  return page.evaluate(() => {
    const target = window as unknown as {
      __onlineSettlementEvents?: Array<{ at: number; token: string; confirmed: boolean }>
    }
    return target.__onlineSettlementEvents ?? []
  })
}

async function openingHistory(page: Page, stop = false): Promise<OpeningSample[]> {
  return page.evaluate((shouldStop) => {
    const target = window as unknown as {
      __onlineOpeningStages?: OpeningSample[]
      __onlineOpeningSampler?: number
    }
    if (shouldStop && target.__onlineOpeningSampler) window.clearInterval(target.__onlineOpeningSampler)
    return target.__onlineOpeningStages ?? []
  }, stop)
}

async function winEffectHistory(page: Page): Promise<WinEffectSample[]> {
  return page.evaluate(() => {
    const target = window as unknown as { __onlineWinEffects?: WinEffectSample[] }
    return target.__onlineWinEffects ?? []
  })
}

async function attachDualScreenshots(pages: [Page, Page], testInfo: TestInfo, name: string) {
  const shots = await Promise.all(pages.map((page) => page.screenshot()))
  await Promise.all(shots.map((body, index) => testInfo.attach(
    `${name}-${index === 0 ? 'host' : 'client'}`,
    { body, contentType: 'image/png' },
  )))
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
  })))
  return new Error(`${message}\nstates=${JSON.stringify(states)}\nlogs=${JSON.stringify(logs.map((x) => x.slice(-30)))}`)
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
  for (const page of [host, client]) {
    await page.getByRole('button', { name: '准备 / 取消准备' }).waitFor({ timeout: 50_000 })
  }
  await expect(host.locator('.room-seat')).toHaveCount(2)
  await expect(client.locator('.room-seat')).toHaveCount(2)
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
  await Promise.all(openingPromises)
  const pages: [Page, Page] = [host, client]
  await attachDualScreenshots(pages, testInfo, `online-match-${matchIndex}-opening-start`)
  // 生产构建不暴露 Vue 内部 props；按与 openingTimeline 一致的可见时间轴
  // 在双端取证。截图会在报告中人工复核骰子/翻精牌/牌山开口和发牌位置。
  await host.waitForTimeout(1350)
  await attachDualScreenshots(pages, testInfo, `online-match-${matchIndex}-opening-first-dice`)
  await host.waitForTimeout(1950)
  await attachDualScreenshots(pages, testInfo, `online-match-${matchIndex}-opening-flip`)
  await host.waitForTimeout(1250)
  await attachDualScreenshots(pages, testInfo, `online-match-${matchIndex}-opening-second-dice`)
  await host.waitForTimeout(1950)
  await attachDualScreenshots(pages, testInfo, `online-match-${matchIndex}-opening-deal`)
  for (const page of [host, client]) {
    await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 150_000 }).toBeGreaterThanOrEqual(4)
    await expect(page.locator('.player-seat')).toHaveCount(3)
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
  // 两个真实账号都通过页面可见控件操作；客端不使用会干扰 OAuth 回跳的
  // ?auto=1，而是在收到真实回合/响应 UI 后点击胡、过或首张可打牌。
  await Promise.all([host, client].map(installHostAutoPlayer))

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
  const settlementEvidence = new Map<string, {
    popup: [number, number]
    confirmed: [number, number]
  }>()

  while (Date.now() < deadline) {
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
    const roundToken = (value: string) => {
      const round = value.match(/东[1-4]局/)?.[0] ?? ''
      const honba = value.match(/(\d+)本场/)?.[1] ?? '0'
      return round ? `${round}:${honba}` : ''
    }
    for (let index = 0; index < settlementEvents.length; index += 1) {
      const events = settlementEvents[index]
      for (const event of events.slice(settlementEventCounts[index])) {
        const evidence = settlementEvidence.get(event.token) ?? { popup: [0, 0], confirmed: [0, 0] }
        evidence.popup[index] ||= event.at
        if (event.confirmed) evidence.confirmed[index] ||= event.at
        settlementEvidence.set(event.token, evidence)
      }
      settlementEventCounts[index] = events.length
    }
    const clientHand = labels[1]

    if (clientHand && clientHand !== activeHand) {
      const first = !activeHand
      const previousHand = activeHand
      if (previousHand) {
        const evidence = settlementEvidence.get(roundToken(previousHand))
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
      const currentSettlement = settlementVisible.some(Boolean)
        && roundToken(settlementText) === roundToken(clientHand)
      waitingForPreviousSettlementToClear = !first && settlementVisible.some(Boolean) && !currentSettlement
      activeHandStartedAt = first ? matchStartedAt : (waitingForPreviousSettlementToClear ? 0 : activeHandObservedAt)
      settledHand = ''
      settlementStartedAt = 0
      transitionHand = ''
      const currentEvidence = settlementEvidence.get(roundToken(activeHand))
      popupSeenAt = currentEvidence ? [...currentEvidence.popup] as [number, number] : [0, 0]
      confirmedAt = currentEvidence ? [...currentEvidence.confirmed] as [number, number] : [0, 0]
    }

    const replaced = settlementVisible.some(Boolean)
      && roundToken(settlementText) === roundToken(activeHand)
    if (waitingForPreviousSettlementToClear && (settlementVisible.every((x) => !x) || replaced)) {
      waitingForPreviousSettlementToClear = false
      activeHandStartedAt = activeHandObservedAt
    }
    const settlementMatchesActive = settlementTexts.map((text, index) => (
      settlementVisible[index] && roundToken(text) === roundToken(activeHand)
    ))
    if (activeHand && activeHandStartedAt > 0 && !waitingForPreviousSettlementToClear
      && settlementMatchesActive.some(Boolean) && settledHand !== activeHand) {
      settledHand = activeHand
      settlementStartedAt = Date.now()
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
      const evidence = settlementEvidence.get(roundToken(activeHand)) ?? { popup: [0, 0], confirmed: [0, 0] }
      evidence.popup = [...popupSeenAt] as [number, number]
      settlementEvidence.set(roundToken(activeHand), evidence)
    }
    // 弹窗可能在 500ms 轮询之间出现并因自动确认立即消失；以页面内 20ms
    // MutationObserver 历史补齐 popupSeenAt/confirmedAt，避免把快速正常切局误报为漏弹窗。
    const currentEvidence = settlementEvidence.get(roundToken(activeHand))
    if (currentEvidence) {
      popupSeenAt = [...currentEvidence.popup] as [number, number]
      confirmedAt = [...currentEvidence.confirmed] as [number, number]
    }
    const firstPopupAt = popupSeenAt.find(Boolean) ?? 0
    // 主动恢复最坏包含 5s 心跳发现、3s SDK reconnect 观察和 2.5s 重进缓冲；
    // 双端弹窗仍须在 20s 内同步，否则不算可接受的流畅恢复。
    if (firstPopupAt && !popupSeenAt.every(Boolean) && Date.now() - firstPopupAt > 20_000) {
      throw await diagnostics(host, client, consoleLogs,
        `线上第 ${matchIndex} 场 ${activeHand} 双端结算弹窗 20 秒仍未同步`)
    }
    if (activeHand && activeHandStartedAt > 0 && settledHand !== activeHand
      && Date.now() - activeHandStartedAt > 360_000) {
      throw await diagnostics(host, client, consoleLogs,
        `线上第 ${matchIndex} 场 ${activeHand} 仍未结算，超过 6 分钟`)
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
      for (const event of autoEvents[index]) {
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
    if (finals.every(Boolean)) break
    if (confirmedAt.every(Boolean) && Date.now() - Math.max(...confirmedAt) > 10_000) {
      throw await diagnostics(host, client, consoleLogs,
        `线上第 ${matchIndex} 场 ${activeHand} 双端确认后 10 秒仍未进入下一局或最终结算`)
    }
    const firstConfirmedAt = confirmedAt.find(Boolean) ?? 0
    if (firstConfirmedAt && !confirmedAt.every(Boolean) && Date.now() - firstConfirmedAt > 20_000) {
      throw await diagnostics(host, client, consoleLogs,
        `线上第 ${matchIndex} 场 ${activeHand} 一端确认后 20 秒另一端仍未确认`)
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
  expect(openingCycles[1].length, `第 ${matchIndex} 场客户端开局动画次数不同步`).toBe(openingCycles[0].length)
  const finalWinEffects = await Promise.all(pages.map(winEffectHistory))
  expect(finalWinEffects[0].length, `第 ${matchIndex} 场房主未捕获胡牌特效`).toBeGreaterThan(0)
  expect(finalWinEffects[1].length, `第 ${matchIndex} 场客户端胡牌特效次数与房主不同步`)
    .toBe(finalWinEffects[0].length)
  const fault = /PLAYER_COUNT|玩家数[=为](?:0|3)|洗牌承诺超时|\[wall-regress\]|非法状态快照|确认后长时间未收到推进信号|房主连接中断|尝试重新加入房间/i
  for (let index = 0; index < consoleLogs.length; index += 1) {
    expect(consoleLogs[index].filter((line) => fault.test(line)), `线上第 ${matchIndex} 场页面 ${index} 出现应用故障`).toEqual([])
  }
  await testInfo.attach(`online-match-${matchIndex}-result`, {
    body: JSON.stringify({
      roomCode, timings, transitionTimings, huEffectCaptures,
      openingHistories: finalOpeningHistories,
      winEffects: finalWinEffects,
      elapsedSeconds: Math.round((Date.now() - matchStartedAt) / 1000),
    }),
    contentType: 'application/json',
  })
  console.log(`[ONLINE] 第 ${matchIndex} 个东风场通过，房间 ${roomCode}`)
  return { roomCode, timings }
}

test('两个线上账号完成两个莲花麻将东风场，每手不超过6分钟', async ({ browser }, testInfo) => {
  const contexts = await Promise.all(ONLINE.accounts.map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })))
  try {
    // 游戏授权令牌位于当前标签页的 sessionStorage；必须复用授权返回的两个页面，
    // 不能只保留 VibeHub Cookie 后另开标签。
    const pages = [
      await authenticate(contexts[0], ONLINE.accounts[0]),
      await authenticate(contexts[1], ONLINE.accounts[1]),
    ]
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
    }
    expect(recoveryMarkers, '线上页面未加载事件驱动恢复构建').toEqual([
      expectedMarkers,
      expectedMarkers,
    ])
    const logs = pages.map(() => [] as string[])
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
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
