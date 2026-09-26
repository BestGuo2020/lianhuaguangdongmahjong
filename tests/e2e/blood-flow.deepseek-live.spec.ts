import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const configFile = process.env.BLOOD_FLOW_DEEPSEEK_CONFIG
// The test injects a real key into an ephemeral browser context; keep it out of Playwright traces.
test.use({ trace: 'off' })

test('three real DeepSeek opponents complete a local blood-flow east match', async ({ page }) => {
  test.skip(!configFile, 'Set BLOOD_FLOW_DEEPSEEK_CONFIG to a local LLM settings JSON file')
  test.setTimeout(3_600_000)

  const saved = JSON.parse(readFileSync(configFile!, 'utf8')) as {
    presets: Array<{ id: string; providerType?: string; model: string; apiKey: string; baseUrl: string }>
  }
  const model = process.env.BLOOD_FLOW_DEEPSEEK_MODEL
  const preset = saved.presets.find(item => item.providerType === 'deepseek' && (!model || item.model === model))
  expect(preset, 'DeepSeek preset must exist in the supplied settings file').toBeTruthy()
  expect(preset?.apiKey, 'DeepSeek preset must have an API key').toBeTruthy()
  const settings = {
    configVersion: 2, enabled: true, presets: [preset], activeId: preset!.id,
    seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
  }
  await page.addInitScript(value => {
    localStorage.setItem('llm.providers', JSON.stringify(value))
    localStorage.setItem('lgm_analysis_enabled', '1')
  }, settings)
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    const trace = { lastRequest: '', lastResponse: '', lastWindow: '', status: '' }
    Object.defineProperty(window, '__bfWorkerTrace', { value: trace })
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker
        if (String(args[0]).includes('engineWorker')) {
          const send = worker.postMessage.bind(worker)
          worker.postMessage = ((data: { kind?: string; id?: number }, transfer?: Transferable[]) => {
            trace.lastRequest = `${data.kind ?? 'unknown'}#${data.id ?? '?'}`
            return send(data, transfer ?? [])
          }) as typeof worker.postMessage
          worker.addEventListener('message', event => {
            const data = event.data as { id?: number; error?: string; result?: { roundId?: string; window?: { id?: string }; public?: { status?: string } } }
            trace.lastResponse = String(data.id ?? '')
            trace.lastWindow = data.result?.window?.id ?? ''
            trace.status = data.result?.public?.status ?? ''
            if (data?.error) console.error(`[blood-flow-worker] ${data.error}`)
          })
          worker.addEventListener('error', event => {
            console.error(`[blood-flow-worker] script error: ${event.message}`)
          })
        }
        return worker
      },
    })
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })

  const requestFailures: string[] = []
  const fatalErrors: string[] = []
  let modelRequests = 0
  let modelSuccesses = 0
  page.on('request', request => {
    if (request.url().startsWith('https://api.deepseek.com/')) modelRequests++
  })
  page.on('response', response => {
    if (response.url().startsWith('https://api.deepseek.com/') && response.ok()) modelSuccesses++
  })
  page.on('requestfailed', request => {
    if (request.url().startsWith('https://api.deepseek.com/')) requestFailures.push(request.failure()?.errorText ?? 'request failed')
  })
  page.on('pageerror', error => fatalErrors.push(error.message))
  page.on('crash', () => fatalErrors.push('Chromium page crashed'))
  page.on('console', message => {
    if (message.type() === 'error' && (message.text().includes('[blood-flow]') || message.text().includes('[blood-flow-worker]'))) {
      fatalErrors.push(message.text())
    }
  })

  await page.goto(process.env.BLOOD_FLOW_TARGET_URL ?? '/?bloodFlow=1')
  page.setDefaultTimeout(5_000)
  await page.getByRole('button', { name: /玩法 莲花广麻/ }).click()
  await page.getByRole('button', { name: /莲花麻将·血流/ }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await page.locator('.start-button').click()

  const roundDialog = page.getByRole('dialog', { name: '血流本局结算' })
  const finalDialog = page.getByRole('dialog', { name: '血流最终排名' })
  const actions = [
    page.locator('.turn-action-row button.action.hu'),
    page.locator('.turn-action-row button.action.pass'),
    page.locator('.user-area .hand-rack.playable .hand-tile-slot .mahjong-tile:not(.disabled)'),
  ]
  const deadline = Date.now() + 59 * 60_000
  let settledRounds = 0
  let humanActions = 0
  let lastProgress = Date.now()
  let lastChange = Date.now()
  let lastModelRequests = 0
  let lastHumanActions = 0
  while (Date.now() < deadline) {
    if (await finalDialog.isVisible().catch(() => false)) break
    if (await roundDialog.isVisible().catch(() => false)) {
      settledRounds++
      console.log(`[deepseek-live] settled=${settledRounds}, human actions=${humanActions}, model requests=${modelRequests}, ok=${modelSuccesses}, failed=${requestFailures.length}`)
      await roundDialog.getByRole('button', { name: /继续下一局/ }).click()
      await roundDialog.waitFor({ state: 'hidden', timeout: 20_000 })
      continue
    }
    if (fatalErrors.length) throw new Error(fatalErrors.at(-1))
    if (await page.getByText('对局已中断，请返回大厅重开').isVisible().catch(() => false)) {
      throw new Error(`Blood-flow interrupted after ${settledRounds} completed rounds; ${fatalErrors.at(-1) ?? 'no captured error'}`)
    }
    let acted = false
    for (const target of actions) {
      try {
        if (await target.first().isVisible() && await target.first().isEnabled()) {
          await target.first().click({ timeout: 1_500 })
          humanActions++
          acted = true
          break
        }
      } catch { /* the window may advance while Playwright checks the locator */ }
    }
    if (!acted) await page.waitForTimeout(200)
    if (modelRequests !== lastModelRequests || humanActions !== lastHumanActions) {
      lastModelRequests = modelRequests
      lastHumanActions = humanActions
      lastChange = Date.now()
    }
    if (Date.now() - lastChange > 120_000) {
      const diagnostic = await Promise.race([page.evaluate(() => {
        const hud = document.querySelector<HTMLElement>('.game-table-hud')
        return {
          phase: hud?.dataset.phase ?? 'no-hud',
          openingStage: hud?.dataset.openingStage ?? '',
          wallCount: hud?.dataset.wallCount ?? '',
          discardCounts: hud?.dataset.discardCounts ?? '',
          turnButtons: [...document.querySelectorAll<HTMLElement>('.turn-action-row button')].map(button => button.textContent?.trim() ?? ''),
          playableTiles: document.querySelectorAll('.user-area .hand-rack.playable .hand-tile-slot .mahjong-tile:not(.disabled)').length,
          announcements: [...document.querySelectorAll<HTMLElement>('[role="status"]')].map(node => node.textContent?.trim().slice(0, 80) ?? ''),
          worker: (window as unknown as { __bfWorkerTrace?: unknown }).__bfWorkerTrace,
        }
      }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Browser page stopped responding to diagnostics')), 5_000))])
      console.log('[deepseek-live] stalled state', JSON.stringify(diagnostic))
      await Promise.race([page.screenshot({ path: 'test-results/blood-flow-deepseek-stall.png', timeout: 5_000 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Stalled page screenshot timed out')), 5_000))]).catch(() => {})
      throw new Error(`No model request or human action for 120 seconds: ${JSON.stringify(diagnostic)}`)
    }
    if (Date.now() - lastProgress > 30_000) {
      const phase = await page.locator('.game-table-hud').first().getAttribute('data-phase').catch(() => 'no-hud')
      console.log(`[deepseek-live] waiting; phase=${phase}, settled=${settledRounds}, human actions=${humanActions}, model requests=${modelRequests}, ok=${modelSuccesses}, failed=${requestFailures.length}`)
      lastProgress = Date.now()
    }
  }

  console.log(`[deepseek-live] final; rounds=${settledRounds + 1}, human actions=${humanActions}, model requests=${modelRequests}, ok=${modelSuccesses}, failed=${requestFailures.length}`)
  expect(fatalErrors).toEqual([])
  expect(modelRequests).toBeGreaterThan(0)
  expect(modelSuccesses).toBeGreaterThan(0)
  expect(settledRounds).toBe(3)
  await expect(finalDialog).toBeVisible()
})
