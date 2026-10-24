// 实机验证：莲花麻将开局 骰子 → 翻精方位 → 3D 指示牌位置 的对应关系。
// 打开本地莲花麻将对局，读取 Vue 组件实例的真实状态（diceValues/flipStack/flipSeat/wallBreakIndex），
// 打印开局时间线，并统计「骰面出现 5」时翻精墩落在哪家墙段。
import { chromium } from 'playwright'

const launchArgs = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=IntensiveWakeUpThrottling',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function readTableState(page) {
  return page.evaluate(() => {
    const out = {}
    const seen = new Set()
    for (const el of document.querySelectorAll('*')) {
      const inst = el.__vueParentComponent
      if (!inst || !inst.props || seen.has(inst.uid)) continue
      seen.add(inst.uid)
      const p = inst.props
      if ('flipStack' in p || 'flip-stack' in p || 'wallBreakIndex' in p) {
        out.flipStack = p.flipStack ?? p['flip-stack'] ?? null
        out.diceValues = p.diceValues ?? p['dice-values'] ?? null
        out.wallBreakIndex = p.wallBreakIndex ?? p['wall-break-index'] ?? null
        out.localSeat = p.localSeat ?? p['local-seat'] ?? null
        out.openingStage = p.openingStage ?? p['opening-stage'] ?? null
        out.flipTile = p.flipTile ?? p['flip-tile'] ?? null
        out.dealer = p.dealerIndex ?? p['dealer-index'] ?? null
        out.diceThrower = p.diceThrowerIndex ?? p['dice-thrower-index'] ?? null
        out.wallHeadDrawn = p.wallHeadDrawn ?? p['wall-head-drawn'] ?? null
        out.wallCount = p.wallCount ?? p['wall-count'] ?? null
        break
      }
    }
    return out
  })
}

function sideOfStack(stack) {
  if (stack == null) return null
  const s = ((stack % 68) + 68) % 68
  if (s < 17) return '近墙·本家面前(庄)'
  if (s < 34) return '左墙·上家'
  if (s < 51) return '远墙·对家'
  return '右墙·下家'
}

async function runOneGame(browser, index) {
  const page = await browser.newPage()
  const events = []
  try {
    await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' })
    // 选择「莲花麻将」玩法
    await page.locator('.game-settings button', { hasText: '玩法' }).click()
    await page.getByRole('button', { name: /莲花麻将/ }).click()
    await page.getByRole('button', { name: '确定' }).click()
    await page.getByRole('button', { name: /开始东风场/ }).click()
    await page.locator('canvas.mahjong-scene').waitFor({ timeout: 15_000 })

    let lastFlipStack = null
    let lastStage = null
    let flipEvent = null
    let snapshotTaken = false
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const st = await readTableState(page).catch(() => ({}))
      const flipStack = st.flipStack ?? null
      const stage = st.openingStage ?? null
      if (flipStack !== lastFlipStack || stage !== lastStage || !snapshotTaken) {
        events.push({
          t: Date.now() % 100000,
          stage,
          dice: st.diceValues ? [...st.diceValues] : null,
          flipStack,
          flipSeatSide: sideOfStack(flipStack),
          breakIndex: st.wallBreakIndex ?? null,
          dealer: st.dealer ?? null,
          thrower: st.diceThrower ?? null,
          wallHead: st.wallHeadDrawn ?? null,
          wallCount: st.wallCount ?? null,
        })
        lastFlipStack = flipStack
        lastStage = stage
        snapshotTaken = true
      }
      // 翻精阶段截图一次
      if (stage === 'flip' && !flipEvent && st.flipTile) {
        flipEvent = { ...events[events.length - 1], flipTile: st.flipTile }
        const path = `D:/vueprojects/lianhua_guangma/.verify-wall-flip-${index}.png`
        await page.screenshot({ path })
        flipEvent.screenshot = path
      }
      if (stage === null && lastStage === 'deal') break
      await sleep(120)
    }
    return { events, flipEvent }
  } finally {
    await page.close()
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: launchArgs })
  const all = []
  try {
    // 跑 6 局收集随机骰子分布
    for (let i = 0; i < 6; i += 1) {
      const r = await runOneGame(browser, i)
      all.push(r)
      console.log(`\n===== 第 ${i + 1} 局 =====`)
      for (const e of r.events) {
        console.log(
          `stage=${e.stage} dice=${JSON.stringify(e.dice)} flipStack=${e.flipStack}(${e.flipSeatSide})`
          + ` break=${e.breakIndex} dealer=${e.dealer} thrower=${e.thrower} head=${e.wallHead} wall=${e.wallCount}`,
        )
      }
      if (r.flipEvent) {
        console.log(`翻精截图: ${r.flipEvent.screenshot} 指示牌=${r.flipEvent.flipTile}`)
      }
    }
    // 汇总：骰面出现 5 的情况
    console.log('\n===== 骰面含 5 的局（用户场景）=====')
    for (const r of all) {
      for (const e of r.events) {
        if (e.dice && e.dice.includes(5) && e.flipStack != null) {
          console.log(
            `dice=[${e.dice}] 总和=${e.dice[0] + e.dice[1]} → flipStack=${e.flipStack}(${e.flipSeatSide})`
            + ` 期望方位=(dealer+sum-1)%4=(0+${e.dice[0] + e.dice[1]}-1)%4=${(e.dice[0] + e.dice[1] - 1) % 4}`,
          )
        }
      }
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
