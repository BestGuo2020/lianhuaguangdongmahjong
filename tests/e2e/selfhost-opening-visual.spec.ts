// 2 真人 + 2 AI 开局视觉取证：记录房主/客人在 start、一骰、翻精、二骰、发牌
// 各阶段的完整页面截图与短视频，并输出实际 dice/flipStack/wallBreakIndex 时间线。
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const SIGNALING = 'wss://www.bestguo.top:58787'
const TURN = 'turn:turn:DZxaEm35GmecFZj@113.45.254.130:53478'
const APP = `http://127.0.0.1:5173/?selfHost=${SIGNALING}&turn=${TURN}`
const APP_AUTO = `${APP}&auto=1`

test.setTimeout(240_000)

async function acceptDisclaimerIfShown(page: Page) {
  const accept = page.getByRole('button', { name: '同意并继续' })
  try {
    await accept.waitFor({ state: 'visible', timeout: 3000 })
    await accept.click()
  } catch {
    // 已同意过时不会弹窗。
  }
}

async function enterRemoteLobby(page: Page, nickname: string, app: string) {
  await page.goto(app)
  await page.getByRole('radio', { name: /联机对战/ }).click()
  await page.getByPlaceholder('输入昵称').fill(nickname)
}

interface VisualState {
  stage: string | null
  dice: number[] | null
  secondDice: number[] | null
  flipStack: number | null
  flipTile: string | null
  wallBreakIndex: number | null
  wallHeadDrawn: number | null
  wallCount: number | null
  dealSerial: number | null
  dealPlayer: number | null
  dealCount: number | null
  localSeat: number | null
  dealer: number | null
  diceThrower: number | null
}

async function readVisualState(page: Page): Promise<VisualState> {
  return page.evaluate(() => {
    const seen = new Set<number>()
    for (const element of document.querySelectorAll('*')) {
      const instance = (element as Element & { __vueParentComponent?: any }).__vueParentComponent
      if (!instance?.props || seen.has(instance.uid)) continue
      seen.add(instance.uid)
      const props = instance.props as Record<string, any>
      if (!('wallBreakIndex' in props) || !('openingStage' in props)) continue
      const deal = props.dealAnimation ?? null
      return {
        stage: props.openingStage ?? null,
        dice: Array.isArray(props.diceValues) ? [...props.diceValues] : null,
        secondDice: Array.isArray(props.secondDice) ? [...props.secondDice] : null,
        flipStack: props.flipStack ?? null,
        flipTile: props.flipTile ?? null,
        wallBreakIndex: props.wallBreakIndex ?? null,
        wallHeadDrawn: props.wallHeadDrawn ?? null,
        wallCount: props.wallCount ?? null,
        dealSerial: deal?.serial ?? null,
        dealPlayer: deal?.playerIndex ?? null,
        dealCount: deal?.count ?? null,
        localSeat: props.localSeat ?? null,
        dealer: props.dealer ?? null,
        diceThrower: props.diceThrowerIndex ?? null,
      }
    }
    return {
      stage: null, dice: null, secondDice: null, flipStack: null, flipTile: null,
      wallBreakIndex: null, wallHeadDrawn: null, wallCount: null, dealSerial: null,
      dealPlayer: null, dealCount: null, localSeat: null, dealer: null, diceThrower: null,
    }
  })
}

async function capturePair(
  pages: Page[],
  testInfo: TestInfo,
  label: string,
  states: VisualState[],
) {
  // 两端并行截图。串行截 WebGL 页面可能耗掉整个 1.2s 翻精窗口，导致观察器
  // 在截完一骰后直接看到发牌，误判中间阶段不存在。
  const shots = await Promise.all(pages.map((page) => page.screenshot()))
  await Promise.all(shots.map((body, index) => testInfo.attach(
    `${label}-${index === 0 ? 'host' : 'client'}`,
    { body, contentType: 'image/png' },
  )))
  console.log(`[visual] ${label}: ${JSON.stringify(states)}`)
}

test('逐阶段记录骰子、翻精、牌山与发牌动画', async ({ browser }, testInfo) => {
  const videoDir = testInfo.outputPath('videos')
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } }),
    browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } }),
  ])
  const pages = await Promise.all(contexts.map((context) => context.newPage()))
  const videos = pages.map((page) => page.video())

  try {
    const host = pages[0]
    const client = pages[1]
    await enterRemoteLobby(host, '视觉房主', APP)
    await host.getByRole('button', { name: '创建房间' }).click()
    await host.locator('.game-settings button', { hasText: '玩法' }).click()
    await host.getByRole('button', { name: /莲花麻将/ }).click()
    await host.getByRole('button', { name: '确定' }).click()
    await host.getByRole('button', { name: '确认创建' }).click()
    await acceptDisclaimerIfShown(host)
    await host.locator('.room-code strong').waitFor({ timeout: 30_000 })
    const roomCode = (await host.locator('.room-code strong').innerText()).trim()

    await enterRemoteLobby(client, '视觉客人', APP_AUTO)
    await client.getByRole('button', { name: '加入房间' }).click()
    await client.getByPlaceholder('输入 6 位房间码').fill(roomCode)
    await client.getByRole('button', { name: '确认加入' }).click()
    await acceptDisclaimerIfShown(client)
    for (const page of pages) {
      await page.getByRole('button', { name: '准备 / 取消准备' }).waitFor({ timeout: 40_000 })
      await page.getByRole('button', { name: '准备 / 取消准备' }).click()
    }

    const start = host.getByRole('button', { name: /开始对局/ })
    await expect(start).toBeEnabled({ timeout: 40_000 })
    await start.click()

    // 页面内高频记录阶段，不受 Playwright 截图耗时影响；静态截图和 WebM
    // 用于视觉核对，阶段历史用于证明 flip/二骰确实在渲染状态中停留过。
    for (const page of pages) {
      await page.evaluate(() => {
        const target = window as unknown as {
          __openingStageHistory?: Array<{ at: number; stage: string | null; dice: number[] | null; flipTile: string | null }>
          __openingStageSampler?: number
        }
        target.__openingStageHistory = []
        let previous = '__unset__'
        target.__openingStageSampler = window.setInterval(() => {
          const elements = document.querySelectorAll('*')
          for (const element of elements) {
            const props = (element as Element & { __vueParentComponent?: any }).__vueParentComponent?.props as Record<string, any> | undefined
            if (!props || !('wallBreakIndex' in props) || !('openingStage' in props)) continue
            const stage = props.openingStage ?? null
            const key = `${stage}:${JSON.stringify(props.diceValues)}:${props.flipTile ?? ''}`
            if (key !== previous) {
              previous = key
              target.__openingStageHistory?.push({
                at: performance.now(),
                stage,
                dice: Array.isArray(props.diceValues) ? [...props.diceValues] : null,
                flipTile: props.flipTile ?? null,
              })
            }
            break
          }
        }, 20)
      })
    }

    const captured = new Set<string>()
    let diceOccurrence = 0
    let lastStage: string | null = null
    let dealFrames = 0
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const states = await Promise.all(pages.map(readVisualState))
      const stage = states[0].stage
      if (stage === 'dice' && lastStage !== 'dice') diceOccurrence += 1
      lastStage = stage
      let label: string | null = null
      if (stage === 'start' && !captured.has('start')) label = '01-start'
      else if (stage === 'dice' && diceOccurrence === 1 && !captured.has('dice-1')) label = '02-dice-1'
      else if (stage === 'flip' && !captured.has('flip')) label = '03-flip'
      else if (stage === 'dice' && diceOccurrence >= 2 && !captured.has('dice-2')) label = '04-dice-2'
      else if (stage === 'deal' && dealFrames < 3) {
        dealFrames += 1
        label = `05-deal-${dealFrames}`
      }

      if (label) {
        captured.add(label.replace(/^\d+-/, '').replace(/-\d+$/, (value) => value))
        if (label.includes('dice-1')) captured.add('dice-1')
        if (label.includes('dice-2')) captured.add('dice-2')
        if (label.includes('start')) captured.add('start')
        if (label.includes('flip')) captured.add('flip')
        await capturePair(pages, testInfo, label, states)
      }
      if (stage == null && captured.has('flip') && dealFrames >= 3) break
      await host.waitForTimeout(stage === 'deal' ? 260 : 80)
    }

    const histories = await Promise.all(pages.map((page) => page.evaluate(() => (
      window as unknown as { __openingStageHistory?: unknown[] }
    ).__openingStageHistory ?? [])))
    console.log(`[visual] stage histories: ${JSON.stringify(histories)}`)
    for (const history of histories as Array<Array<{ stage: string | null }>>) {
      expect(history.some((entry) => entry.stage === 'start')).toBe(true)
      expect(history.filter((entry) => entry.stage === 'dice')).toHaveLength(2)
      expect(history.some((entry) => entry.stage === 'flip')).toBe(true)
      expect(history.some((entry) => entry.stage === 'deal')).toBe(true)
    }
    expect(captured.has('start')).toBe(true)
    expect(captured.has('dice-1')).toBe(true)
    // WebGL 全页截图可能横跨整个 1.2s flip 窗口；是否真实渲染以页面内
    // 20ms 阶段历史和完整 WebM 为准，不能把截图调用耗时误判为产品跳帧。
    expect(dealFrames).toBeGreaterThanOrEqual(3)
    for (const page of pages) {
      await expect.poll(() => page.locator('.hand-tile-slot').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4)
      await expect(page.locator('.player-seat')).toHaveCount(3)
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }

  for (let index = 0; index < videos.length; index += 1) {
    const path = await videos[index]?.path()
    if (path) await testInfo.attach(`opening-video-${index === 0 ? 'host' : 'client'}`, { path, contentType: 'video/webm' })
  }
})
