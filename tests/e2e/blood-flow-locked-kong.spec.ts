import { expect, test, type Page } from '@playwright/test'

test.setTimeout(60_000)

test('a locked player can see and click the real discard-kong button after the quick-auto delay', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/blood-flow-claims.html?lockedKong=1&lockedAutoMs=800&countdown=1')
  const gang = page.locator('.action-bar').getByRole('button', { name: '杠', exact: true })
  await expect(gang).toBeVisible()
  await expect(page.locator('.action-bar').getByRole('button', { name: '过', exact: true })).toHaveCount(0)
  await page.clock.install({ time: new Date('2026-09-19T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-09-19T00:00:00Z'))
  await page.clock.runFor(1_200)
  expect(await page.evaluate(() => (window as any).__claimEvidence().commands)).toEqual([])
  await gang.click()
  await expect.poll(() => page.evaluate(() => (window as any).__claimEvidence().commands[0]?.action.kind)).toBe('gang')
})

test('a locked player may explicitly pass a discard-kong when no win is available', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/blood-flow-claims.html?lockedKong=1&kongOnly=1&lockedAutoMs=800')
  const actions = page.locator('.action-bar')
  await expect(actions.getByRole('button', { name: '杠', exact: true })).toBeVisible()
  await expect(actions.getByRole('button', { name: '胡', exact: true })).toHaveCount(0)
  await actions.getByRole('button', { name: '过', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__claimEvidence().commands[0]?.action.kind)).toBe('pass')
})

// Exercise the real shared adapter with authority snapshots and a controlled clock.
// Actions are supplied at the projection boundary; engine kong legality is tested separately.
async function setup(page: Page, kind: string, canWin = true) {
  await page.goto('/tests/e2e/fixtures/blood-flow-claims.html')
  await expect(page.locator('.action-bar')).toBeVisible()
  await page.clock.install({ time: new Date('2026-09-19T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-09-19T00:00:00Z'))
  await page.evaluate(async ({ kind, canWin }) => {
    const { useBloodFlowGame } = await import('/src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts')
    const { BloodFlowEngine } = await import('/src/game/variants/lotus/bloodFlow/engine.ts')
    const { bloodFlowSeatView } = await import('/src/game/variants/lotus/bloodFlow/seatView.ts')
    const engine = new BloodFlowEngine({ authorityEpoch: 'locked-kong', roundId: '1', now: Date.now })
    const snapshot = bloodFlowSeatView(engine, 0)
    snapshot.public.seats[0].locked = true
    snapshot.players[0].melds = [{ type: 'peng', tile: 'm1', tiles: ['m1','m1','m1'] }]
    snapshot.players[0].drawnTileIndex = snapshot.players[0].hand.length - 1
    snapshot.window!.opensAt = 0
    snapshot.window!.deadlineAt = Date.now() + 15_000
    snapshot.window!.kind = kind === 'gang' || kind === 'pass' ? 'meld' : 'turn'
    const kong = kind === 'concealed-kong' ? { kind, tile: 'm1' }
      : kind === 'added-kong' ? { kind, meldIndex: 0 } : { kind }
    const base = snapshot.window!.kind === 'turn'
      ? { kind: 'discard', index: snapshot.players[0].drawnTileIndex } : { kind: 'pass' }
    snapshot.ownActions = [...(canWin ? [{ kind: 'win' }] : []), base,
      ...(['discard','pass'].includes(kind) ? [] : [kong])] as any
    const commands: any[] = []
    const game = useBloodFlowGame({ externalAuthority: {
      send: command => commands.push(command), nextRound() {}, leave() {}, openingDone() {},
    } })
    const meta = { round: 1, dealer: 0, mode: 'east' as const }
    await game.acceptRemoteView(snapshot, meta)
    ;(window as any).__lockedKong = {
      evidence: () => ({ commands, seconds: game.turnSeconds.value }),
      refresh: () => game.acceptRemoteView(snapshot, meta),
      addKong: () => {
        snapshot.ownActions.push({ kind: 'concealed-kong', tile: 'm1' })
        return game.acceptRemoteView(snapshot, meta)
      },
      choose: () => {
        if (kind === 'gang') game.userGangFromDiscard()
        else if (kind === 'wind-kong') game.capabilities.value.windKong.execute()
        else game.userGang('m1')
      },
      dispose: game.dispose,
    }
  }, { kind, canWin })
}

for (const kind of ['gang', 'concealed-kong', 'added-kong', 'wind-kong']) {
  for (const canWin of [false, true]) {
    test(`locked ${kind}, win=${canWin}: keeps the full decision window for manual choice`, async ({ page }) => {
      await setup(page, kind, canWin)
      await page.clock.runFor(1_200)
      await page.evaluate(() => (window as any).__lockedKong.refresh())
      await page.clock.runFor(12_800)
      const evidence = await page.evaluate(() => (window as any).__lockedKong.evidence())
      expect(evidence.commands).toEqual([])
      // The visible counter updates once a second; refreshing shifts its tick phase.
      expect(evidence.seconds).toBeGreaterThanOrEqual(1)
      expect(evidence.seconds).toBeLessThanOrEqual(2)
      await page.evaluate(() => (window as any).__lockedKong.choose())
      expect(await page.evaluate(() => (window as any).__lockedKong.evidence().commands.map((c: any) => c.action.kind))).toEqual([kind])
    })
  }
}

for (const [kind, canWin, expected] of [['discard', false, 'discard'], ['discard', true, 'win'], ['pass', false, 'pass']] as const) {
  test(`locked without a kong still automatically chooses ${expected}`, async ({ page }) => {
    await setup(page, kind, canWin)
    await page.clock.runFor(799)
    expect(await page.evaluate(() => (window as any).__lockedKong.evidence().commands)).toEqual([])
    await page.clock.runFor(1)
    expect(await page.evaluate(() => (window as any).__lockedKong.evidence().commands.map((c: any) => c.action.kind))).toEqual([expected])
  })
}

test('a refreshed kong option prevents an already scheduled automatic win', async ({ page }) => {
  await setup(page, 'discard', true)
  await page.clock.runFor(400)
  await page.evaluate(() => (window as any).__lockedKong.addKong())
  await page.clock.runFor(600)
  expect(await page.evaluate(() => (window as any).__lockedKong.evidence().commands)).toEqual([])
})
