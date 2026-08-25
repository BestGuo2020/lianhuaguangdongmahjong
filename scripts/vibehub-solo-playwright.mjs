import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_VIBEHUB_URL = 'https://vibe.lumigrav.space/works/B5AJupT1/'
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000
const POLL_INTERVAL_MS = 250
const ACTION_SETTLE_MS = 150

const config = {
  url: process.env.VIBEHUB_URL || DEFAULT_VIBEHUB_URL,
  timeZone: process.env.VIBEHUB_TIME_ZONE || DEFAULT_TIME_ZONE,
  logDir: path.resolve(process.env.VIBEHUB_LOG_DIR || path.join('logs', 'vibehub-single-player')),
  timeoutMs: Number(process.env.VIBEHUB_MATCH_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  headless: process.env.PW_HEADLESS !== '0',
  slowMo: Number(process.env.PW_SLOW_MO || 0),
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requireHttpUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`VIBEHUB_URL 必须是 http/https 地址：${value}`)
  }
  return url.toString()
}

function dateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, value]))
}

function logFileName(date = new Date()) {
  const parts = dateParts(date)
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}-${parts.second}.md`
}

function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ')
}

function scoreRow(names, scores) {
  return [scores.label, ...names.map((name) => scores.values[name] ?? '—')]
}

function markdownLog(names, rounds, finalScores) {
  const header = ['局', ...names].map(cell)
  const separator = ['---', ...names.map(() => '---:')]
  const rows = rounds.map((round) => scoreRow(names, round))
  rows.push(scoreRow(names, { label: '最终分数', values: finalScores }))
  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    '',
  ].join('\n')
}

async function visible(locator) {
  try {
    return await locator.count() > 0 && await locator.first().isVisible()
  } catch {
    return false
  }
}

async function clickIfReady(locator) {
  try {
    const target = locator.first()
    if (!await target.isVisible() || !await target.isEnabled()) return false
    await target.click({ timeout: 2_000 })
    await sleep(ACTION_SETTLE_MS)
    return true
  } catch {
    // Transition 动画期间元素可能刚好被替换；下一轮轮询会重新定位。
    return false
  }
}

async function selectMatchAndRule(page) {
  const settings = page.locator('.game-settings')
  await settings.getByRole('button').filter({ hasText: '场次' }).click()
  const matchDialog = page.getByRole('dialog', { name: '选择场次' })
  await matchDialog.getByRole('button', { name: /半庄场/ }).click()
  await matchDialog.getByRole('button', { name: '确定', exact: true }).click()

  await settings.getByRole('button').filter({ hasText: '玩法' }).click()
  const ruleDialog = page.getByRole('dialog', { name: '选择规则玩法' })
  await ruleDialog.getByRole('button', { name: /莲花麻将/ }).click()
  await ruleDialog.getByRole('button', { name: '确定', exact: true }).click()

  await page.getByRole('button', { name: /开始半庄场/ }).click()
  await page.locator('.game-table-hud').waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('canvas.mahjong-scene').waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('.flip-indicator').waitFor({ state: 'visible', timeout: 45_000 })
}

async function readPlayerNames(page) {
  const names = await page.locator('.game-table-hud').evaluate(() => {
    const selectors = [
      '.user-area .player-info strong',
      '.player-seat.seat-right .player-info strong',
      '.player-seat.seat-top .player-info strong',
      '.player-seat.seat-left .player-info strong',
    ]
    return selectors.map((selector) => document.querySelector(selector)?.textContent?.trim() || '')
  })
  if (names.length !== 4 || names.some((name) => !name)) {
    throw new Error(`无法从牌桌读取四位玩家名称：${JSON.stringify(names)}`)
  }
  return names
}

async function readRoundScores(page) {
  return page.locator('.settlement-card').evaluate((card) => {
    const title = card.querySelector('h2')?.textContent?.trim() || '未知局'
    const label = title.split('·')[0].trim()
    const values = {}
    for (const article of card.querySelectorAll('.round-rankings article')) {
      const line = article.querySelector('.player-line')
      const clone = line?.cloneNode(true)
      clone?.querySelectorAll('i').forEach((item) => item.remove())
      const name = clone?.textContent?.trim() || ''
      const score = Number(article.querySelector('b')?.textContent?.trim())
      if (name && Number.isFinite(score)) values[name] = score
    }
    return { label, values }
  })
}

async function readFinalScores(page) {
  return page.locator('.final-board').evaluate((board) => {
    const values = {}
    for (const article of board.querySelectorAll('.final-rankings article')) {
      const name = article.querySelector('.final-name strong')?.textContent?.trim() || ''
      const score = Number(article.querySelector('em')?.textContent?.trim())
      if (name && Number.isFinite(score)) values[name] = score
    }
    return values
  })
}

async function driveUntilSettlementOrFinished(page, deadline) {
  const huButton = page.locator('.turn-action-row button.action.hu')
  const passButton = page.locator('.turn-action-row button.action.pass')
  const tile = page.locator('.user-area .hand-rack.playable .hand-tile-slot .mahjong-tile:not(.disabled)')

  while (Date.now() < deadline) {
    if (await visible(page.locator('.final-board'))) return 'finished'
    if (await visible(page.locator('.round-settlement'))) return 'settled'

    // 胡优先；没有胡时，所有需要本家响应的吃/碰/杠/抢杠胡提示都选择过。
    if (await clickIfReady(huButton)) continue
    if (await clickIfReady(passButton)) continue
    if (await clickIfReady(tile)) continue

    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`对局超过 ${Math.round(config.timeoutMs / 60_000)} 分钟仍未结束`)
}

async function playMatch(page) {
  await selectMatchAndRule(page)
  const names = await readPlayerNames(page)
  const rounds = []
  const deadline = Date.now() + config.timeoutMs

  while (true) {
    const state = await driveUntilSettlementOrFinished(page, deadline)
    if (state === 'finished') break

    const round = await readRoundScores(page)
    const missing = names.filter((name) => round.values[name] == null)
    if (missing.length) {
      throw new Error(`结算页缺少玩家分数：${missing.join('、')}`)
    }
    rounds.push(round)

    const settlement = page.locator('.round-settlement')
    const continueButton = page.locator('.settlement-card .result-actions button:not(.secondary)').first()
    await continueButton.waitFor({ state: 'visible', timeout: 10_000 })
    await continueButton.click({ timeout: 10_000 })
    // 等旧结算层完成退出动画，避免下一轮轮询把它重复读取成新的一局。
    await settlement.waitFor({ state: 'hidden', timeout: 10_000 })
  }

  const finalScores = await readFinalScores(page)
  const missingFinal = names.filter((name) => finalScores[name] == null)
  if (missingFinal.length) {
    throw new Error(`终局页缺少玩家最终分数：${missingFinal.join('、')}`)
  }
  if (!rounds.length) throw new Error('未读取到任何一局结算分数')
  return { names, rounds, finalScores }
}

async function writeLog(result) {
  await mkdir(config.logDir, { recursive: true })
  const file = path.join(config.logDir, logFileName())
  await writeFile(file, markdownLog(result.names, result.rounds, result.finalScores), 'utf8')
  return file
}

async function main() {
  const url = requireHttpUrl(config.url)
  const args = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=IntensiveWakeUpThrottling',
    '--disable-dev-shm-usage',
    '--use-angle=swiftshader',
  ]
  if (process.env.PW_NO_SANDBOX === '1') args.push('--no-sandbox')

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.slowMo,
    args,
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.setDefaultNavigationTimeout(60_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: '莲花广麻' }).waitFor({ state: 'visible' })
    const result = await playMatch(page)
    const file = await writeLog(result)
    console.log(`对局完成，共记录 ${result.rounds.length} 局：${file}`)
  } finally {
    await context.close()
    await browser.close()
  }
}

main().catch((error) => {
  console.error(`[vibehub-single-player] ${error instanceof Error ? error.stack || error.message : error}`)
  process.exitCode = 1
})
