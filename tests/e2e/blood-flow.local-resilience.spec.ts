import { expect, test } from '@playwright/test'

test.setTimeout(150_000)

async function startFastLocalGame(page: import('@playwright/test').Page, recorder?: boolean) {
  await page.goto('/?bloodFlow=1')
  await page.evaluate(async (withRecorder) => {
    const [{ useBloodFlowGame }, { buildRingWall }, { seededRandom }] = await Promise.all([
      import('/src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts'),
      import('/src/game/variants/lotus/lotusWall.ts'),
      import('/src/game/variants/lotus/bloodFlow/simulation.ts'),
    ])
    let roundStarts = 0
    const hooks = withRecorder ? {
      roundStart() { if (++roundStarts === 2) throw new Error('Injected replay failure in round two') },
      draw() {}, discard() {}, tableAction() {}, roundEnd() {},
    } : undefined
    const game = useBloodFlowGame({ autoplay: true, paceMs: 0, playSoundAndWait: async () => {}, recorder: hooks })
    ;(window as any).__resilienceGame = game
    ;(window as any).__roundStartCalls = () => roundStarts
    await game.startGame('east', { initialWall: buildRingWall(seededRandom(91)), openingDice: [2, 3], openingSecondDice: [1, 4] })
  }, Boolean(recorder))
  await expect.poll(() => page.evaluate(() => (window as any).__resilienceGame.phase.value),
    { timeout: 100_000, intervals: [500] }).toBe('settled')
}

test('reuses the local engine worker when the next round starts offline', async ({ page, context }) => {
  let engineLoads = 0
  await context.route('**/*engineWorker*', route => {
    engineLoads++
    return route.continue()
  })
  await startFastLocalGame(page)
  expect(engineLoads).toBe(1)
  await context.setOffline(true)
  await page.evaluate(() => (window as any).__resilienceGame.nextRound())
  await expect.poll(() => page.evaluate(() => (window as any).__resilienceGame.view.value?.roundId),
    { timeout: 30_000, intervals: [250] }).toBe('round-2')
  expect(engineLoads).toBe(1)
  expect(await page.evaluate(() => (window as any).__resilienceGame.view.value?.public.status)).not.toBe('interrupted')
})

test('replay failure at the round boundary does not interrupt local play', async ({ page }) => {
  await startFastLocalGame(page, true)
  await page.evaluate(() => (window as any).__resilienceGame.nextRound())
  await expect.poll(() => page.evaluate(() => (window as any).__roundStartCalls()),
    { timeout: 30_000, intervals: [250] }).toBeGreaterThanOrEqual(2)
  await expect.poll(() => page.evaluate(() => (window as any).__resilienceGame.view.value?.roundId),
    { timeout: 30_000, intervals: [250] }).toBe('round-2')
  expect(await page.evaluate(() => (window as any).__resilienceGame.view.value?.public.status)).not.toBe('interrupted')
  expect(await page.evaluate(() => (window as any).__resilienceGame.announcement.value?.text ?? '')).not.toContain('返回大厅重开')
})

test('a transient worker start error retries the same local round', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker
        if (String(args[0]).includes('engineWorker')) {
          const send = worker.postMessage.bind(worker)
          let starts = 0
          worker.postMessage = ((data: { kind?: string; id?: number }, transfer?: Transferable[]) => {
            if (data.kind === 'start' && ++starts === 2) {
              queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', {
                data: { id: data.id, error: 'injected transient worker error' },
              })))
              return
            }
            return send(data, transfer ?? [])
          }) as typeof worker.postMessage
        }
        return worker
      },
    })
  })
  await startFastLocalGame(page)
  await page.evaluate(() => (window as any).__resilienceGame.nextRound())
  await expect.poll(() => page.evaluate(() => (window as any).__resilienceGame.view.value?.roundId),
    { timeout: 30_000, intervals: [250] }).toBe('round-2')
  expect(await page.evaluate(() => (window as any).__resilienceGame.view.value?.public.status)).not.toBe('interrupted')
  expect(await page.evaluate(() => (window as any).__resilienceGame.announcement.value?.text ?? '')).not.toContain('返回大厅重开')
})
