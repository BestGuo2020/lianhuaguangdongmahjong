// 公网 selfHost + TURN 完整回归：2 真人 + 2 AI，连续打完两个莲花麻将东风场。
//
// 两个真实浏览器 context 分别扮演房主和客人；引擎会为空余的 seat 2/3 自动补 AI。
// 房主由页面内自动点击器驱动，客人使用 ?auto=1 的真实远端动作协议。每局结算时
// 两端主动点「继续」，缩短等待，但仍完整经过后续局承诺洗牌与 opening barrier。
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const SIGNALING = 'wss://www.bestguo.top:58787'
const TURN = 'turn:turn:DZxaEm35GmecFZj@113.45.254.130:53478'
const APP = `http://127.0.0.1:5173/?selfHost=${SIGNALING}&turn=${TURN}`
const APP_AUTO = `${APP}&auto=1`

test.describe.configure({ mode: 'serial' })
test.setTimeout(4_800_000)

async function enterRemoteLobby(page: Page, nickname: string, app: string) {
  await page.goto(app)
  await page.getByRole('radio', { name: /联机对战/ }).click()
  await page.getByPlaceholder('输入昵称').fill(nickname)
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
    const state = window as unknown as { __twoHumanHostAuto?: number; __twoHumanHostClicks?: number }
    if (state.__twoHumanHostAuto) return
    state.__twoHumanHostClicks = 0
    state.__twoHumanHostAuto = window.setInterval(() => {
      const actionBar = document.querySelector('.action-bar')
      if (actionBar) {
        const hu = actionBar.querySelector<HTMLButtonElement>('.action.hu')
        if (hu) { hu.click(); return }
        const pass = actionBar.querySelector<HTMLButtonElement>('.action.pass')
        if (pass) { pass.click(); return }
      }

      const rack = document.querySelector('.hand-rack.playable')
      if (!rack) return
      const firstTile = rack.querySelector<HTMLElement>('.hand-tile-slot .mahjong-tile')
      if (!firstTile) return
      firstTile.click()
      state.__twoHumanHostClicks = (state.__twoHumanHostClicks ?? 0) + 1
    }, 120)
  })
}

async function clickContinueIfAvailable(page: Page) {
  const button = page.locator('.round-settlement .result-actions button').filter({ hasText: /^继续/ })
  if (await button.count() === 0) return
  if (await button.first().isVisible().catch(() => false) && await button.first().isEnabled().catch(() => false)) {
    // 结算层可能在检查可点击性后立刻切到 opening；这里不能沿用 30s 默认
    // actionability 等待，否则一个已经消失的按钮会把整个采样/超时诊断卡住。
    await button.first().click({ timeout: 1000 }).catch(() => {})
  }
}

async function readRoundLabel(page: Page) {
  return page.locator('.round-info').innerText({ timeout: 1000 }).catch(() => '')
}

async function readPageDiagnostics(page: Page) {
  return {
    round: await readRoundLabel(page),
    settlement: await page.locator('.round-settlement').isVisible().catch(() => false),
    settlementText: await page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => ''),
    final: await page.locator('.final-backdrop').isVisible().catch(() => false),
    banners: await page.locator('.remote-banner').allInnerTexts().catch(() => [] as string[]),
    playable: await page.locator('.hand-rack.playable').isVisible().catch(() => false),
    actionBar: await page.locator('.action-bar').innerText({ timeout: 1000 }).catch(() => ''),
  }
}

async function diagnosticError(host: Page, client: Page, consoleLogs: string[][], message: string) {
  const [hostState, clientState] = await Promise.all([
    readPageDiagnostics(host),
    readPageDiagnostics(client),
  ])
  const tails = consoleLogs.map((logs) => logs.slice(-20))
  return new Error(`${message}\nhost=${JSON.stringify(hostState)}\nclient=${JSON.stringify(clientState)}\nlogs=${JSON.stringify(tails)}`)
}

async function runEastMatch(options: {
  host: Page
  client: Page
  matchIndex: number
  consoleLogs: string[][]
  testInfo: TestInfo
}) {
  const { host, client, matchIndex, consoleLogs, testInfo } = options
  const matchLogStarts = consoleLogs.map((logs) => logs.length)
  const suffix = `${matchIndex}-${Date.now().toString(36).slice(-5)}`

  await enterRemoteLobby(host, `房主-${suffix}`, APP)
  await host.getByRole('button', { name: '创建房间' }).click()
  await host.locator('.game-settings button', { hasText: '玩法' }).click()
  await host.getByRole('button', { name: /莲花麻将/ }).click()
  await host.getByRole('button', { name: '确定' }).click()
  await host.getByRole('button', { name: '确认创建' }).click()
  await acceptDisclaimerIfShown(host)
  await host.locator('.room-code strong').waitFor({ timeout: 30_000 })
  const roomCode = (await host.locator('.room-code strong').innerText()).trim()
  expect(roomCode).toMatch(/^[A-Z0-9]{6}$/)

  await enterRemoteLobby(client, `客人-${suffix}`, APP_AUTO)
  await client.getByRole('button', { name: '加入房间' }).click()
  await client.getByPlaceholder('输入 6 位房间码').fill(roomCode)
  await client.getByRole('button', { name: '确认加入' }).click()
  await acceptDisclaimerIfShown(client)

  for (const page of [host, client]) {
    await page.getByRole('button', { name: '准备 / 取消准备' }).waitFor({ timeout: 40_000 })
  }

  // 大厅只有两个真人席；开局后由引擎补齐两个 AI。
  await expect(host.locator('.room-seat')).toHaveCount(2)
  await expect(client.locator('.room-seat')).toHaveCount(2)
  await host.getByRole('button', { name: '准备 / 取消准备' }).click()
  await client.getByRole('button', { name: '准备 / 取消准备' }).click()
  const start = host.getByRole('button', { name: /开始对局/ })
  await expect(start).toBeEnabled({ timeout: 40_000 })
  const firstOpening = [host, client].map((page) => page.locator('.opening-overlay').waitFor({
    state: 'visible',
    timeout: 60_000,
  }))
  const startedAt = Date.now()
  await start.click()
  await Promise.all(firstOpening)

  const openingSeen = [true, true]
  for (const [index, page] of [host, client].entries()) {
    await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 120_000 }).toBeGreaterThanOrEqual(4)
    await expect(page.locator('.player-seat')).toHaveCount(3)
    openingSeen[index] = openingSeen[index] || await page.locator('.opening-overlay').count() > 0
  }
  await installHostAutoPlayer(host)

  const observedHost: string[] = []
  const observedClient: string[] = []
  const markers = ['东1局', '东2局', '东3局', '东4局']
  // 整个东风场允许因连庄增加手数；用户验收门限是每一手（round + honba）
  // 不得超过 6 分钟。总窗口只防止测试进程无限运行。
  const deadline = startedAt + 3_600_000
  let activeHand = ''
  let activeHandStartedAt = startedAt
  let activeHandObservedAt = startedAt
  let settledHand = ''
  let settlementStartedAt = 0
  let lastSettlementSignature = ''
  let waitingForPreviousSettlementToClear = false
  let lastProgressAt = 0
  while (Date.now() < deadline) {
    const labels = await Promise.all([readRoundLabel(host), readRoundLabel(client)])
    const settlements = await Promise.all([
      host.locator('.round-settlement').isVisible().catch(() => false),
      client.locator('.round-settlement').isVisible().catch(() => false),
    ])
    const settlementTexts = await Promise.all([host, client].map((page, index) => (
      settlements[index]
        ? page.locator('.round-settlement').innerText({ timeout: 1000 }).catch(() => '')
        : Promise.resolve('')
    )))
    const visibleSettlementText = settlementTexts.find(Boolean) ?? ''
    // “继续 (N)”倒计时和确认后的等待文案会持续变化，不能作为结算是否已换局的依据。
    // 保留局号、得分与和牌信息，生成一份跨确认状态稳定的结算签名。
    const settlementSignature = visibleSettlementText
      .split('\n')
      .filter((line) => !/查看牌桌|继续(?:\s*\(\d+\))?|等待其他玩家|已确认/.test(line))
      .join('\n')
    const roundToken = (value: string) => value.match(/东[1-4]局/)?.[0] ?? ''
    // 客人只消费房主权威快照，以它的 round-info 作为手牌计时键；本场修复后
    // 房主自视也应很快收敛到同一个 `(round, honba)`。
    const clientHand = labels[1]
    if (clientHand && clientHand !== activeHand) {
      const firstHand = activeHand === ''
      if (activeHand) {
        // 极短结算层可能恰好落在两个 500ms 采样点之间；此时用“上一手标签首次
        // 出现 → 下一手标签首次出现”的保守上界验收，仍不得超过 6 分钟。
        const completedAt = settledHand === activeHand && settlementStartedAt > 0
          ? settlementStartedAt
          : Date.now()
        const duration = completedAt - (activeHandStartedAt || activeHandObservedAt)
        console.log(`[2H2AI][第${matchIndex}场] ${activeHand} 完成上界 ${Math.round(duration / 1000)}s`)
        if (duration > 360_000) {
          throw await diagnosticError(host, client, consoleLogs,
            `第 ${matchIndex} 场 ${activeHand} 完成超过 6 分钟（${Math.round(duration / 1000)}s）`)
        }
      }
      activeHand = clientHand
      activeHandObservedAt = Date.now()
      // 引擎可能先把 round-info 更新成下一手，上一手结算层随后才退场。
      // 必须等旧结算真正消失再为新手起表，否则会把旧层误认成新手“0秒结算”。
      // 但起手胡可能让新手结算无缝替换旧结算；标题 round 或内容签名已经变化时，
      // 当前可见层就是新手结果，不能反过来误判成“跳过一局”。
      const settlementBelongsToCurrentHand = settlements.some(Boolean)
        && roundToken(visibleSettlementText) === roundToken(clientHand)
        && settlementSignature !== lastSettlementSignature
      waitingForPreviousSettlementToClear = !firstHand
        && settlements.some(Boolean)
        && !settlementBelongsToCurrentHand
      activeHandStartedAt = firstHand
        ? startedAt
        : (waitingForPreviousSettlementToClear ? 0 : activeHandObservedAt)
      settledHand = ''
      settlementStartedAt = 0
    }
    const currentSettlementHasReplacedPrevious = settlements.some(Boolean)
      && roundToken(visibleSettlementText) === roundToken(activeHand)
      && settlementSignature !== lastSettlementSignature
    if (waitingForPreviousSettlementToClear
      && (settlements.every((visible) => !visible) || currentSettlementHasReplacedPrevious)) {
      waitingForPreviousSettlementToClear = false
      activeHandStartedAt = activeHandObservedAt
      console.log(`[2H2AI][第${matchIndex}场] ${activeHand} 开始（旧结算已退场或被当前结算替换）`)
    }
    // “一局不超过 6 分钟”计到该手结算出现为止；结算后的真人确认/下一局启动
    // 是另一条推进 SLA，不能继续算进上一手耗时。
    if (activeHand && activeHandStartedAt > 0 && !waitingForPreviousSettlementToClear
      && settlements.some(Boolean) && settledHand !== activeHand) {
      settledHand = activeHand
      settlementStartedAt = Date.now()
      lastSettlementSignature = settlementSignature
      const duration = settlementStartedAt - activeHandStartedAt
      console.log(`[2H2AI][第${matchIndex}场] ${activeHand} 结算耗时 ${Math.round(duration / 1000)}s`)
      if (duration > 360_000) {
        throw await diagnosticError(host, client, consoleLogs,
          `第 ${matchIndex} 场 ${activeHand} 到结算超过 6 分钟（${Math.round(duration / 1000)}s）`)
      }
    }
    if (activeHand && activeHandStartedAt > 0 && !waitingForPreviousSettlementToClear
      && settledHand !== activeHand && Date.now() - activeHandStartedAt > 360_000) {
      throw await diagnosticError(host, client, consoleLogs,
        `第 ${matchIndex} 场 ${activeHand} 仍未结算，单手超过 6 分钟`)
    }
    if (settledHand === activeHand && settlementStartedAt > 0 && Date.now() - settlementStartedAt > 180_000) {
      throw await diagnosticError(host, client, consoleLogs,
        `第 ${matchIndex} 场 ${activeHand} 结算确认后 180 秒仍未推进`)
    }
    for (const marker of markers) {
      if (labels[0].includes(marker) && !observedHost.includes(marker)) observedHost.push(marker)
      if (labels[1].includes(marker) && !observedClient.includes(marker)) observedClient.push(marker)
    }
    openingSeen[0] = openingSeen[0] || await host.locator('.opening-overlay').count() > 0
    openingSeen[1] = openingSeen[1] || await client.locator('.opening-overlay').count() > 0

    await clickContinueIfAvailable(host)
    await clickContinueIfAvailable(client)

    const newFaults = consoleLogs.flatMap((logs, index) => logs
      .slice(matchLogStarts[index])
      .filter((line) => /确认后长时间未收到推进信号|尝试重新加入房间|房主连接中断/i.test(line))
      .map((line) => `page${index}: ${line}`))
    if (newFaults.length > 0) {
      throw await diagnosticError(host, client, consoleLogs,
        `第 ${matchIndex} 场出现自动重进/房主失联：${newFaults.join(' | ')}`)
    }

    const finals = await Promise.all([
      host.locator('.final-backdrop').count(),
      client.locator('.final-backdrop').count(),
    ])
    if (finals.every((count) => count > 0)) break

    if (Date.now() - lastProgressAt >= 30_000) {
      lastProgressAt = Date.now()
      console.log(`[2H2AI][第${matchIndex}场][${Math.floor((Date.now() - startedAt) / 1000)}s] host=${labels[0]} client=${labels[1]} observed=${observedHost.join('→')}`)
    }
    await host.waitForTimeout(500)
  }

  expect(observedHost, `第 ${matchIndex} 场房主轮次不完整`).toEqual(markers)
  expect(observedClient, `第 ${matchIndex} 场客人轮次不完整`).toEqual(markers)
  expect(openingSeen, `第 ${matchIndex} 场双方均应观察到开局动画`).toEqual([true, true])
  await expect(host.locator('.final-backdrop')).toBeVisible({ timeout: 120_000 })
  await expect(client.locator('.final-backdrop')).toBeVisible({ timeout: 120_000 })
  await expect(host.getByText('最终排名')).toBeVisible()
  await expect(client.getByText('最终排名')).toBeVisible()

  // 长时间运行后的 WebGL canvas 在 headless SwiftShader 下做全页截图会让 GPU
  // 进程持续满载并卡住测试收尾；开局视觉已有独立 WebM 取证，这里保存终局文本即可。
  const finalTexts = await Promise.all([host, client].map((page) => (
    page.locator('.final-backdrop').innerText({ timeout: 5000 })
  )))
  await Promise.all(finalTexts.map((body, index) => testInfo.attach(
    `match-${matchIndex}-${index === 0 ? 'host' : 'client'}-final`,
    { body, contentType: 'text/plain' },
  )))

  const matchLogs = consoleLogs.map((logs, index) => logs.slice(matchLogStarts[index]))
  const forbidden = /PLAYER_COUNT|玩家数[=为](?:0|3)|洗牌承诺超时|\[wall-regress\]|非法状态快照|确认后长时间未收到推进信号|重进后倒计时到 3|房主连接中断|尝试重新加入房间/i
  for (let i = 0; i < matchLogs.length; i += 1) {
    expect(matchLogs[i].filter((line) => forbidden.test(line)), `第 ${matchIndex} 场页面 ${i} 出现应用层故障日志`).toEqual([])
  }
  for (const page of [host, client]) {
    const banners = await page.locator('.remote-banner').allInnerTexts().catch(() => [] as string[])
    expect(banners.join('\n')).not.toMatch(/网络断开|连接中断|尝试重新加入/)
  }

  console.log(`[2H2AI] 第 ${matchIndex} 个东风场通过，房间 ${roomCode}，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
  return roomCode
}

test('2 真人 + 2 AI 连续打完两个莲花麻将东风场', async ({ browser }, testInfo) => {
  const rooms: string[] = []
  for (let matchIndex = 1; matchIndex <= 2; matchIndex += 1) {
    // 每个东风场使用全新 context：避免长时间 WebGL/SwiftShader 资源占用影响
    // 上一场终局后的指针点击，也确保两场是两个真正独立的房间/会话。
    const contexts = await Promise.all([0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })))
    const pages = await Promise.all(contexts.map((context) => context.newPage()))
    const pageErrors = pages.map(() => [] as string[])
    const consoleLogs = pages.map(() => [] as string[])
    pages.forEach((page, index) => {
      page.on('pageerror', (error) => pageErrors[index].push(error.message))
      page.on('console', (message) => {
        const line = message.text()
        if (/\[host\]|\[client\]|\[selfHost\]|\[diag\]|error|warn|丢弃|重进|洗牌|快照|continue|shuffle|AI 代打|wall-regress/i.test(line)) {
          consoleLogs[index].push(line)
        }
      })
    })
    try {
      rooms.push(await runEastMatch({ host: pages[0], client: pages[1], matchIndex, consoleLogs, testInfo }))
      expect(pageErrors[0], `第 ${matchIndex} 场房主出现未捕获异常`).toEqual([])
      expect(pageErrors[1], `第 ${matchIndex} 场客人出现未捕获异常`).toEqual([])
    } finally {
      await Promise.all(contexts.map((context) => context.close()))
    }
  }
  expect(new Set(rooms).size, '两个东风场应使用两个独立房间').toBe(2)
  console.log(`[2H2AI] 两个东风场完整通过：${rooms.join(' → ')}`)
})
