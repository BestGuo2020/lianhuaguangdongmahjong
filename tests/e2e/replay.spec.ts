import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

// 对局回放端到端（三个玩法）：
// fixture 用真实引擎各打完整场东风场并落库到 IndexedDB → 真实 App 在大厅列出 → 打开 3D 回放视图。
test.describe.configure({ mode: 'serial' })
test.setTimeout(720_000)

const OUT = 'work/replay-e2e'

interface FixtureMatch {
  rulesetId: string
  rulesetName: string
  themeName: string
  rounds: number
  status: string
  rank: number | null
  flipTile: string | null
  jokers: number
  steps: number
  wins: number
  labels: string[]
  roundNumbers: number[]
  hooksLog: string[]
}

test('整场录制可在真实 App 里回放（三种玩法 / 列表 / 3D 牌桌 / 单步 / 切局 / 视角 / 主题）', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mkdir(OUT, { recursive: true })

  // ── 1. 真实引擎跑完三种玩法并入本地库 ──
  await page.goto('/tests/e2e/fixtures/replay.html')
  await expect(page.locator('body')).toHaveAttribute('data-replay-fixture', 'ready', { timeout: 360_000 })
  const fixture = await page.evaluate(() => (
    window as unknown as { __replayFixture: { matches: FixtureMatch[]; errors: string[] } }
  ).__replayFixture)
  expect(fixture.errors).toEqual([])
  expect(fixture.matches).toHaveLength(3)

  const byRuleset = (id: string) => fixture.matches.find((match) => match.rulesetId === id)!
  for (const id of ['lotus-classic', 'lotus-legacy', 'lotus-blood-flow']) {
    const recorded = byRuleset(id)
    const detail = `${id} 诊断：labels=[${recorded.labels.join('|')}] roundNumbers=[${recorded.roundNumbers.join(',')}] hooks=[${recorded.hooksLog.join(' ; ')}]`
    expect(recorded.rounds, `${id} 局数 ${detail}`).toBeGreaterThanOrEqual(4)
    expect(recorded.steps, `${id} 事件数 ${detail}`).toBeGreaterThan(20)
    expect(recorded.status, `${id} 场次状态 ${detail}`).toBe('finished')
    expect(recorded.rank, `${id} 位次`).toBeGreaterThanOrEqual(1)
    expect(recorded.rank, `${id} 位次`).toBeLessThanOrEqual(4)
  }
  // 广麻以白板为癞子，无翻精指示牌；两种莲花玩法都有翻精
  expect(byRuleset('lotus-classic').flipTile).toBeNull()
  expect(byRuleset('lotus-classic').jokers).toBe(1)
  expect(byRuleset('lotus-legacy').flipTile).not.toBeNull()
  expect(byRuleset('lotus-blood-flow').flipTile).not.toBeNull()
  // 血流一局可多次胡牌：和牌事件数应明显多于局数
  expect(byRuleset('lotus-blood-flow').wins).toBeGreaterThanOrEqual(4)

  // ── 2. 大厅列表：三种玩法各一行，玩法 / 场次 / 日期 / 位次 / 主题齐全 ──
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '莲花广麻' })).toBeVisible()
  await page.getByTestId('open-replay').click()
  await expect(page.getByTestId('replay-list')).toBeVisible()
  const rows = page.locator('.replay-row')
  await expect(rows).toHaveCount(3)
  const rowOf = (label: string) => page.locator('.replay-row').filter({ hasText: label })
  await expect(rowOf('莲花麻将·血流')).toContainText('东风场')
  await expect(rowOf('莲花麻将·血流')).toContainText('主题 大模型专属')
  await expect(rowOf('莲花麻将 · 东风场')).toContainText('主题 红木金丝')
  await expect(rowOf('莲花广麻')).toContainText('主题 默认墨玉')
  for (const label of ['莲花麻将·血流', '莲花麻将 · 东风场', '莲花广麻']) {
    await expect(rowOf(label)).toContainText(/\d+局 · [1-4]位/)
    await expect(rowOf(label)).toContainText(/\d{2}:\d{2}/)
  }
  // 等入场动画结束再截图与校验底色（否则截到半透明中间态）
  await page.waitForTimeout(600)
  const cardBackground = await page.locator('.replay-list-card').evaluate((el) => getComputedStyle(el).backgroundImage)
  expect(cardBackground).not.toBe('none')
  await page.screenshot({ path: `${OUT}/01-list.png` })

  const viewer = page.getByTestId('replay-viewer')
  async function openReplay(label: string) {
    // 列表可能已经打开（首次进入时就是打开的），只在关闭状态下点大厅入口。
    if (await page.getByTestId('replay-list').count() === 0) {
      await page.getByTestId('open-replay').click()
    }
    await expect(page.getByTestId('replay-list-rows')).toBeVisible()
    await rowOf(label).getByRole('button', { name: '查看' }).click()
    await expect(viewer).toBeVisible()
    await expect(page.getByTestId('replay-list')).toHaveCount(0)
    await expect(page.locator('canvas.mahjong-scene')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.table-loading')).toHaveCount(0, { timeout: 30_000 })
  }

  // ── 3. 血流回放：多次胡牌 + 无单一赢家的结算帧 + 按记录主题（大模型专属）──
  await openReplay('莲花麻将·血流')
  await expect(viewer).toHaveAttribute('data-table-theme', 'llm')
  await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-table-theme', 'llm')
  await expect(page.locator('.replay-title')).toContainText('莲花麻将·血流')
  await expect(page.locator('.replay-hand-rack .hand-tile-slot')).toHaveCount(14)
  await expect(page.locator('.replay-info-scores li')).toHaveCount(4)
  await expect(page.getByTestId('replay-wall-left')).toContainText('牌山 余')
  await expect(page.getByTestId('replay-turn')).toContainText('1巡')
  await expect(page.locator('.replay-log-list button').first()).toBeVisible()
  // 血流一局多胡：牌谱里应能看到多条「胡/自摸」事件
  const winRows = page.locator('.replay-log-list button').filter({ hasText: /自摸|胡/ })
  expect(await winRows.count()).toBeGreaterThanOrEqual(1)
  // 本家身份牌不得被牌谱面板压住（曾因复用实时牌桌的 .user-area 定位而被遮挡）
  const logBox = await page.locator('.replay-log-body').boundingBox()
  const identityBox = await page.locator('.replay-user .user-identity').boundingBox()
  expect(logBox).not.toBeNull()
  expect(identityBox).not.toBeNull()
  expect(identityBox!.x).toBeGreaterThanOrEqual(logBox!.x + logBox!.width - 1)
  expect(identityBox!.y + identityBox!.height).toBeLessThanOrEqual(720)
  // 无进度条、无主题切换入口
  await expect(page.locator('.replay-viewer input[type="range"]')).toHaveCount(0)
  await expect(page.locator('.replay-topbar select')).toHaveCount(0)
  await expect(page.locator('.replay-theme-name')).toHaveText('主题 llm')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/02-blood-flow-frame0.png` })
  // 局末：血流没有单一赢家 → 横幅报「本局结束」
  await page.locator('.replay-log').click()
  await page.keyboard.press('End')
  await expect(page.getByTestId('replay-result')).toContainText('本局结束')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/03-blood-flow-settled.png` })

  // ── 4. 莲花麻将回放：切局 / 单步 / 牌谱跳转 / 视角开关 ──
  await page.getByRole('button', { name: '← 返回大厅' }).click()
  await expect(viewer).toHaveCount(0)
  await openReplay('莲花麻将 · 东风场')
  await expect(viewer).toHaveAttribute('data-table-theme', 'rosewood')
  await expect(page.locator('.replay-title')).toContainText('莲花麻将')
  await expect(page.locator('.replay-hand-rack .hand-tile-slot')).toHaveCount(14)

  const position = page.getByTestId('replay-turn').locator('i')
  const positionAtStart = (await position.textContent()) ?? ''
  await page.getByRole('button', { name: '下一步' }).click()
  await expect(position).not.toHaveText(positionAtStart)
  await page.getByRole('button', { name: '上一步' }).click()
  await expect(position).toHaveText(positionAtStart)

  await page.keyboard.press('End')
  await expect(page.getByTestId('replay-result')).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/04-lotus-settled.png` })

  await page.keyboard.press('Home')
  const entry = page.locator('.replay-log-list button').nth(6)
  await entry.click()
  await expect(entry).toHaveClass(/active/)
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/05-lotus-step.png` })

  const roundSelect = page.locator('.replay-round select')
  await expect(roundSelect.locator('option')).toHaveCount(byRuleset('lotus-legacy').rounds)
  await roundSelect.selectOption('1')
  const roundLabel = await roundSelect.locator('option').nth(1).innerText()
  await expect(page.locator('.replay-title')).toContainText(roundLabel)
  await expect(page.getByTestId('replay-turn')).toContainText('1巡')

  const toggle = page.locator('.replay-view-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveText('按当时所见')
  // 按当时所见：本家手牌仍在（自己始终看得到），只是不再全知
  expect(await page.locator('.replay-hand-rack .hand-tile-slot').count()).toBeGreaterThanOrEqual(13)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/06-lotus-concealed.png` })
  await toggle.click()
  await expect(toggle).toHaveText('全知视角')

  // ── 5. 莲花广麻回放 ──
  await page.getByRole('button', { name: '← 返回大厅' }).click()
  await openReplay('莲花广麻')
  await expect(viewer).toHaveAttribute('data-table-theme', 'jade')
  await expect(page.locator('.replay-title')).toContainText('莲花广麻')
  await page.getByRole('button', { name: '下一步' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/07-guangma-step.png` })

  expect(errors).toEqual([])
})
