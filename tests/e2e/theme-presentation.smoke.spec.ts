import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const evidenceRoot = 'test-results/theme-presentation'

const phaseFiveThemes = [
  { name: 'jade', frame: 'jade', loading: 'jade-facet' },
  { name: 'rosewood', frame: 'wood', loading: 'wood-lantern' },
  { name: 'llm', frame: 'cosmic', loading: 'llm-scan' },
  { name: 'llmAnime', frame: 'anime', loading: 'anime-panel' },
] as const
const allThemes = [
  { name: 'jade', frame: 'jade' },
  { name: 'happyMahjong', frame: 'playful' },
  { name: 'rosewood', frame: 'wood' },
  { name: 'llm', frame: 'cosmic' },
  { name: 'llmAnime', frame: 'anime' },
] as const
const actionMatrix = [
  { type: 'chi', kind: 'chi', strength: 'medium', label: '吃' },
  { type: 'peng', kind: 'peng', strength: 'medium', label: '碰' },
  { type: 'concealed-gang', kind: 'gang', strength: 'strong', label: '杠' },
  { type: 'self-draw', kind: 'win', strength: 'climax', label: '自摸' },
  { type: 'discard-win', kind: 'win', strength: 'climax', label: '胡' },
  { type: 'robbed-kong-win', kind: 'win', strength: 'climax', label: '抢杠胡' },
] as const
const resultMatrix = [
  { kind: 'self-draw', label: '自摸' },
  { kind: 'discard', label: '点炮' },
  { kind: 'robbed-kong', label: '抢杠胡' },
  { kind: 'draw', label: '流局' },
] as const

test('欢乐麻将形成大厅、HUD、加载和结算连续表现', async ({ page }) => {
  test.setTimeout(120_000)
  await mkdir(evidenceRoot, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/?theme=happyMahjong&winEffectLab=1', { waitUntil: 'domcontentloaded' })

  const shell = page.locator('main.game-app')
  await expect(shell).toHaveAttribute('data-table-theme', 'happyMahjong')
  await expect(shell).toHaveAttribute('data-theme-player-frame', 'playful')
  await expect(shell).toHaveAttribute('data-theme-loading', 'happy-orbit')
  await expect(page.locator('.start-button')).toHaveCSS('border-radius', '18px')
  await page.locator('.win-effect-lab').evaluate((element: HTMLElement) => { element.style.visibility = 'hidden' })
  await page.screenshot({ path: `${evidenceRoot}/happyMahjong-lobby-1366x768.png` })

  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('.game-table-hud')).toHaveAttribute('data-table-theme', 'happyMahjong')
  await expect(page.locator('.seat-left .avatar-wrap')).toHaveCSS('border-radius', '22px')
  await page.screenshot({ path: `${evidenceRoot}/happyMahjong-table-1366x768.png` })

  await page.getByTestId('win-self-0').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.settlement-card')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('.settlement-card')).toHaveCSS('border-radius', '26px')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${evidenceRoot}/happyMahjong-settlement-1366x768.png` })
})

test('Phase 5 四主题形成可辨识的大厅、牌桌动作与结算表现', async ({ page }) => {
  test.setTimeout(480_000)
  await mkdir(evidenceRoot, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })

  const lobbyFingerprints: string[] = []
  const seatFingerprints: string[] = []
  const settlementFingerprints: string[] = []

  for (const theme of phaseFiveThemes) {
    await page.goto(`/?theme=${theme.name}&winEffectLab=1&actionCueLab=peng&actionCueSeat=1`, { waitUntil: 'domcontentloaded' })
    const shell = page.locator('main.game-app')
    await expect(shell).toHaveAttribute('data-table-theme', theme.name)
    await expect(shell).toHaveAttribute('data-theme-player-frame', theme.frame)
    await expect(shell).toHaveAttribute('data-theme-loading', theme.loading)
    await expect(page.locator('.character-shortcut')).toHaveCount(theme.name === 'llmAnime' ? 1 : 0)

    lobbyFingerprints.push(await page.locator('.lobby').evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.backgroundColor}|${style.backgroundImage}`
    }))
    await page.locator('.win-effect-lab').evaluate((element: HTMLElement) => { element.style.visibility = 'hidden' })
    await page.screenshot({ path: `${evidenceRoot}/${theme.name}-lobby-1366x768.png` })

    await page.getByRole('button', { name: /开始东风场/ }).click()
    await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('.game-table-hud')).toHaveAttribute('data-table-theme', theme.name)
    if (theme.name === 'llmAnime') await expect(page.locator('.anime-action-cue')).toBeVisible()
    else await expect(page.locator('.table-action-cue')).toBeVisible()

    seatFingerprints.push(await page.locator('.seat-left .avatar-wrap').evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.borderRadius}|${style.borderColor}|${style.backgroundImage}|${style.boxShadow}`
    }))
    await page.screenshot({ path: `${evidenceRoot}/${theme.name}-table-action-1366x768.png` })

    await page.getByTestId('win-self-0').evaluate((element: HTMLElement) => element.click())
    await expect(page.locator('.settlement-card')).toBeVisible({ timeout: 45_000 })
    await page.waitForTimeout(600)
    settlementFingerprints.push(await page.locator('.settlement-card').evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.borderRadius}|${style.borderColor}|${style.backgroundColor}|${style.backgroundImage}|${style.boxShadow}`
    }))
    await page.screenshot({ path: `${evidenceRoot}/${theme.name}-settlement-1366x768.png` })
  }

  expect(new Set(lobbyFingerprints).size).toBe(phaseFiveThemes.length)
  expect(new Set(seatFingerprints).size).toBe(phaseFiveThemes.length)
  expect(new Set(settlementFingerprints).size).toBe(phaseFiveThemes.length)
})

test('Phase 6 五主题覆盖吃碰杠与三类胡牌动作强度', async ({ page }) => {
  test.setTimeout(480_000)
  const actionEvidenceRoot = `${evidenceRoot}/phase6-actions`
  await mkdir(actionEvidenceRoot, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })

  for (const theme of allThemes) {
    await page.goto(`/?theme=${theme.name}&actionCueLab=chi&actionCueSeat=1&scoreFlowLab=1`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /开始东风场/ }).click()
    await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('.start-cue')).toBeHidden({ timeout: 15_000 })
    const cue = page.locator(theme.name === 'llmAnime' ? '.anime-action-cue' : '.table-action-cue')
    await expect(page.locator('.score-delta[data-score-direction="positive"]')).toBeVisible()
    await expect(page.locator('.score-delta[data-score-direction="negative"]')).toBeVisible()

    for (const action of actionMatrix) {
      await page.evaluate(({ type }) => {
        const labWindow = window as typeof window & {
          __setTableActionCueLab?: (value: string, actorIndex?: number) => void
        }
        labWindow.__setTableActionCueLab?.(type, 1)
      }, action)
      await expect(cue).toBeVisible()
      await expect(cue).toHaveAttribute('data-action-type', action.type)
      await expect(cue).toHaveAttribute('data-action-kind', action.kind)
      await expect(cue).toHaveAttribute('data-action-strength', action.strength)
      await expect(cue).toContainText(action.label)
      await page.waitForTimeout(320)
      await page.screenshot({ path: `${actionEvidenceRoot}/${theme.name}-${action.type}.png` })
    }
  }
})

test('Phase 6 五主题覆盖自摸、点炮、抢杠胡与流局结算', async ({ page }) => {
  test.setTimeout(480_000)
  const resultEvidenceRoot = `${evidenceRoot}/phase6-results`
  await mkdir(resultEvidenceRoot, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })

  for (const theme of allThemes) {
    await page.goto(`/?theme=${theme.name}&winEffectLab=1`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /开始东风场/ }).click()
    await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })
    await page.locator('.win-effect-lab').evaluate((element: HTMLElement) => { element.style.visibility = 'hidden' })
    await page.getByTestId('win-self-0').evaluate((element: HTMLElement) => element.click())
    const card = page.locator('.settlement-card')
    await expect(card).toBeVisible({ timeout: 45_000 })
    await page.waitForTimeout(900)

    const fingerprints: string[] = []
    for (const outcome of resultMatrix) {
      await page.evaluate(({ kind }) => {
        const labWindow = window as typeof window & {
          __setRoundResultKindLab?: (value: string) => void
        }
        labWindow.__setRoundResultKindLab?.(kind)
      }, outcome)
      await expect(card).toHaveAttribute('data-result-kind', outcome.kind)
      await expect(card).toHaveAttribute('data-result-strength', outcome.kind === 'draw' ? 'medium' : 'climax')
      await expect(card.locator('h2')).toContainText(outcome.label)
      if (outcome.kind === 'draw') await expect(card.locator('.score-total')).toHaveCount(0)
      fingerprints.push(await card.evaluate((element) => {
        const style = getComputedStyle(element)
        const title = getComputedStyle(element.querySelector('h2')!)
        return `${style.borderStyle}|${style.borderColor}|${style.boxShadow}|${title.color}`
      }))
      await page.screenshot({ path: `${resultEvidenceRoot}/${theme.name}-${outcome.kind}.png` })
    }
    expect(new Set(fingerprints).size).toBe(resultMatrix.length)

    await page.evaluate(() => {
      const labWindow = window as typeof window & { __setFinalRankingLab?: (active: boolean) => void }
      labWindow.__setFinalRankingLab?.(true)
    })
    const finalBoard = page.locator('.final-board')
    await expect(finalBoard).toBeVisible()
    await expect(finalBoard).toHaveAttribute('data-result-kind', 'final')
    await expect(finalBoard).toHaveAttribute('data-result-strength', 'climax')
    await expect(finalBoard.locator('.final-rankings article')).toHaveCount(4)
    await expect(finalBoard).toHaveCSS('animation-duration', '1.25s')
    await page.waitForTimeout(1_300)
    await page.screenshot({ path: `${resultEvidenceRoot}/${theme.name}-final.png` })
  }
})

test('Phase 6 流局使用真实游戏状态，静音与 reduced-motion 不隐藏反馈', async ({ page }) => {
  test.setTimeout(180_000)
  const fallbackEvidenceRoot = `${evidenceRoot}/phase6-fallbacks`
  await mkdir(fallbackEvidenceRoot, { recursive: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/?theme=happyMahjong&winEffectLab=1&actionCueLab=concealed-gang&actionCueSeat=1', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /开始东风场/ }).click()
  await expect(page.locator('.table-loading')).toBeHidden({ timeout: 30_000 })

  await page.getByRole('button', { name: '声音设置' }).click()
  await page.getByRole('switch', { name: /声音总开关/ }).click()
  await expect(page.locator('.top-bar')).toHaveAttribute('data-sound-enabled', 'false')
  const cue = page.locator('.table-action-cue')
  await expect(cue).toHaveAttribute('data-action-kind', 'gang')
  await expect(cue).toBeVisible()
  await expect(cue).toHaveCSS('animation-name', 'none')
  await page.screenshot({ path: `${fallbackEvidenceRoot}/happyMahjong-muted-reduced-motion-action.png` })

  await page.getByTestId('round-draw').evaluate((element: HTMLElement) => element.click())
  const card = page.locator('.settlement-card')
  await expect(card).toBeVisible({ timeout: 45_000 })
  await expect(card).toHaveAttribute('data-result-kind', 'draw')
  await expect(card).toHaveAttribute('data-result-source', 'game')
  await expect(card.locator('h2')).toContainText('流局')
  await expect(card.locator('.round-rankings article')).toHaveCount(4)
  await expect(card).toHaveCSS('animation-name', 'none')
  await page.screenshot({ path: `${fallbackEvidenceRoot}/happyMahjong-muted-reduced-motion-draw.png` })
})
