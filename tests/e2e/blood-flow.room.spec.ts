import { expect, test } from '@playwright/test'

test.setTimeout(180_000)
test('SDK-shaped two-human two-AI room completes an east match with actual authority worker and committed reshuffles', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const { createBloodFlowRoom } = await import('/src/game/online/vibe/bloodFlowRoom.ts')
    const { buildRingWall } = await import('/src/game/variants/lotus/lotusWall.ts')
    const { seededRandom } = await import('/src/game/variants/lotus/bloodFlow/simulation.ts')
    const { decideBloodFlowAction } = await import('/src/game/variants/lotus/bloodFlow/ai.ts')
    const evidence = { done: false, errors: [] as string[], rounds: [] as number[], batchIds: [] as string[][], scores: [] as number[][] }
    ;(window as any).__bloodFlowRoomEvidence = evidence
    const handlers = [[], []] as Array<Array<(message: unknown, from: string) => void>>
    const peerHandlers = [[], []] as Array<Array<(event: unknown) => void>>
    const bindings = new Map([['human-0', 0], ['human-1', 1]])
    const rooms = [0, 1].map(seat => ({
      roomId: 'blood-flow-browser-fixture', peerId: `human-${seat}`, hostId: 'human-0', isHost: seat === 0,
      onMessage: (handler: any) => handlers[seat].push(handler), onPeer: (handler: any) => peerHandlers[seat].push(handler),
      send: (message: unknown, target?: string) => {
        for (let recipient = 0; recipient < 2; recipient++) if (recipient !== seat && (!target || target === `human-${recipient}`)) {
          const data = structuredClone(message)
          queueMicrotask(() => handlers[recipient].forEach(handler => handler(data, `human-${seat}`)))
        }
      },
      peers: () => [{ id: `human-${1 - seat}`, open: true }],
    }))
    const modules = rooms.map((room, seat) => createBloodFlowRoom({ getSeat: () => seat, getMode: () => 'east', getIsHost: () => seat === 0,
      getVerifiedBindings: () => bindings, getPlayerProfile: s => ({ name: `P${s}`, avatar: '', playerKind: s < 2 ? 'human' : 'bot' }),
      leave: () => {}, onError: error => evidence.errors.push(error), paceMs: 0 }))
    const first = Promise.resolve({ initialWall: buildRingWall(seededRandom(87)), openingDice: [2, 3] as [number, number], openingSecondDice: [1, 4] as [number, number] })
    modules.forEach((module, i) => module.attach(rooms[i] as any, first, bindings))
    const sent = new Set<string>(), continued = new Set<string>()
    const timer = setInterval(() => {
      if (evidence.errors.length) { clearInterval(timer); modules.forEach(m => m.stop()); return }
      for (const [seat, module] of modules.entries()) {
        const port = module.port, view = port.view.value
        if (!view) continue
        if (port.phase.value === 'settled') {
          const key = `${seat}:${view.roundId}`
          if (!continued.has(key)) {
            continued.add(key)
            if (seat === 0) evidence.rounds.push(port.round.value)
            if (!port.matchFinished.value) port.nextRound()
          }
          continue
        }
        const action = decideBloodFlowAction(view)
        if (!action || !view.window || port.openingStage.value) continue
        const key = `${seat}:${view.window.id}:${JSON.stringify(action)}`
        if (sent.has(key)) continue
        sent.add(key)
        if (action.kind === 'win') port.userHu()
        else if (action.kind === 'pass') port.userPass()
        else if (action.kind === 'discard') port.userDiscard(action.index)
        else if (action.kind === 'peng') port.userPeng()
        else if (action.kind === 'gang') port.userGangFromDiscard()
        else if (action.kind === 'wind-kong') port.capabilities.value.windKong.execute()
        else if (action.kind === 'concealed-kong') port.userGang(action.tile)
        else if (action.kind === 'added-kong') port.userGang(port.players[0].melds[action.meldIndex].tile)
        else if (action.kind === 'chi') port.capabilities.value.chi.choose(view.ownActions.filter(a => a.kind === 'chi').findIndex(a => JSON.stringify(a) === JSON.stringify(action)))
      }
      if (modules.every(m => m.port.matchFinished.value)) {
        evidence.batchIds = modules.map(m => m.port.view.value!.public.batches.map(b => b.batchId))
        evidence.scores = modules.map(m => m.port.view.value!.players.map(p => p.score))
        evidence.done = true; clearInterval(timer); modules.forEach(m => m.stop())
      }
    }, 10)
  })
  await expect.poll(() => page.evaluate(() => (window as any).__bloodFlowRoomEvidence), { timeout: 150_000, intervals: [1000] }).toMatchObject({ done: true, errors: [] })
  const evidence = await page.evaluate(() => (window as any).__bloodFlowRoomEvidence)
  expect(evidence.rounds).toEqual([1, 2, 3, 4])
  expect(evidence.scores[0]).toEqual(evidence.scores[1])
  expect(evidence.batchIds[0]).toEqual(evidence.batchIds[1])
})
