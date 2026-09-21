import { expect, test, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// §6 联机（P2P）分析记录：房主在**局后**产出赛后私有复现数据 → 经中继下发 → 两端各自落进分析区，
// 并且这份数据必须真的能把每一局重跑到同一结束状态（§10.6）；房主没开分析时，客机如实标"拿不到"。
//
// 为什么用单页双房间而不是两个浏览器上下文：真实 P2P 传输（vibe SDK）在这里无法复现（AGENTS.md
// 「联机验收策略」：本地没有可用的真实 P2P 环境），而这一条要验的是**分析记录的数据通路与复现能力**，
// 与传输实现无关。于是用与 `blood-flow.room.spec.ts` 同一个 SDK 形状的进程内房间（两真人 + 两机器人、
// 承诺洗牌固定种子），把"房主产出 → 清单/分片/回执 → 客机收全校验 → 落库 → 离线复现"整条路走通。
//
// 传输层本身的线上验收仍按 AGENTS.md 另行执行（vibehubcli + 两账号），本用例不替代它。
test.setTimeout(300_000)

interface SideEvidence {
  seat: number
  matchId: string | null
  /** 分析区里每局的复现记录（落库后读回来的那一份，不是内存里的中间值）。 */
  records: Array<{ roundIndex: number; available: boolean; origin?: string; unavailableReason?: string; dealer: number; commands: number; wallLength: number; handLengths: number[]; openingScores: number[] }>
  gaps: Array<{ scope: string; from?: number; reason: string }>
  /** §10.6 判据：用落库的那份数据重跑这一局。 */
  verify: Array<{ roundIndex: number; ok: boolean; reason: string | null; scoresMatch: boolean | null; kindMismatches: number; submitted: number; recorded: number; finalScores: number[]; expectedScores: number[] | null }>
  /** 复现数据的指纹（两端必须一致：客机拿到的就是房主产出的那份）。 */
  digests: string[]
  /** 逐局真实结束分数：取自该局**结算帧的公开 roundResult**，与复现数据、与展示回放都无关。 */
  roundEndings: Array<{ round: number; endingScores: number[] }>
  /** 展示回放的逐局记录（只做观测：分析复现不依赖它）。 */
  replayRounds: Array<{ roundIndex: number; scoresBefore: number[] | null; finalScores: number[] | null }>
  /** 决策记录口径（§3.2/§3.4）：来源与执行回执的分布，用来确认联机 AI 座位的决策也真的入了账。 */
  decisionStats: { total: number; bySource: Record<string, number>; byExecution: Record<string, number>; authorityAccepted: number }
}

interface DriverEvidence {
  done: boolean
  errors: string[]
  warnings: string[]
  hostAnalysis: boolean
  settleMs: Array<{ seat: number; ms: number; diagnostics: Record<string, unknown> }>
  snapshots: string[]
  traces: Array<{ seat: number; trace: string[] }>
  sides: SideEvidence[]
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

/**
 * 驱动一整场联机对局（两个进程内房间），返回两端落库后的分析记录与复现结论。
 * `hostAnalysis=false` 时房主那侧不接分析（生产里对应 `analysis.port === null`）。
 */
async function runDriver(page: Page, url: string): Promise<DriverEvidence> {
  const driverStart = Date.now()
  await page.goto(url)
  await page.evaluate(async () => {
    // 房主那侧是否接分析（第二个用例用 query 关掉）
    const hostAnalysis = !new URLSearchParams(location.search).has('noHostAnalysis')
    const { createBloodFlowRoom } = await import('/src/game/online/vibe/bloodFlowRoom.ts')
    const { buildRingWall } = await import('/src/game/variants/lotus/lotusWall.ts')
    const { seededRandom } = await import('/src/game/variants/lotus/bloodFlow/simulation.ts')
    const { decideBloodFlowAction } = await import('/src/game/variants/lotus/bloodFlow/ai.ts')
    const { BLOOD_FLOW_CONFIG, BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI } = await import('/src/game/variants/lotus/bloodFlow/config.ts')
    const { createAnalysisRecorder } = await import('/src/game/replay/analysis/recorder.ts')
    const { createAnalysisStorage } = await import('/src/game/replay/analysis/storage.ts')
    const { createAnalysisMemoryDriver } = await import('/src/game/replay/analysis/idb.ts')
    const { replayReproduction } = await import('/src/game/replay/analysis/replayReproduction.ts')

    const evidence = {
      done: false,
      errors: [] as string[],
      /** 录制器自报的异常（落库暂停、队列溢出…）：不影响断言，但必须看得见。 */
      warnings: [] as string[],
      hostAnalysis,
      /** 场末收尾耗时与录制器诊断（定位"最后一局为什么没落库"）。 */
      settleMs: [] as Array<{ seat: number; ms: number; diagnostics: Record<string, unknown> }>,
      /** 停滞取证：每秒记一次两端关键状态（超时也能看出卡在哪一侧）。 */
      snapshots: [] as string[],
      /** 房间侧的分析轨迹：回答"这一局的复现数据去哪了"。 */
      traces: [] as Array<{ seat: number; trace: string[] }>,
      sides: [] as SideEvidence[],
    }
    ;(window as any).__analysisP2pEvidence = evidence

    // ── 每端一份内存分析区（e2e 不污染本机 IndexedDB；落库/读取路径与生产同一个 storage）──
    const storages = [0, 1].map(() => createAnalysisStorage({ driver: createAnalysisMemoryDriver() }))
    const recorders: any[] = [null, null]
    const matchIds: Array<string | null> = [null, null]

    /** 稳定代理：与 App 里的 `analysis.port` 同形（换场只换内部录制器）。 */
    function analysisProxy(side: number) {
      const call = (method: string, ...args: unknown[]) => (recorders[side] as any)?.[method]?.(...args)
      return {
        get enabled() { return true },
        paused: () => false,
        beginMatch: (input: unknown) => call('beginMatch', input),
        windowOpened: (input: unknown) => call('windowOpened', input),
        candidates: (input: unknown) => call('candidates', input),
        promptTemplate: (input: unknown) => call('promptTemplate', input),
        chosen: (input: unknown) => call('chosen', input),
        source: (input: unknown) => call('source', input),
        receipt: (input: unknown) => call('receipt', input),
        attemptStarted: (input: unknown) => call('attemptStarted', input) ?? '',
        attemptFinished: (id: unknown, input: unknown) => call('attemptFinished', id, input),
        settlement: (input: unknown) => call('settlement', input),
        reproduction: (input: unknown) => call('reproduction', input),
        noteGap: (gap: unknown) => call('noteGap', gap),
        flush: async (reason: unknown) => { await call('flush', reason) },
        finish: async () => ({ status: 'complete' as const, bytes: 0 }),
        diagnostics: () => ({ decisions: 0, attempts: 0, pendingParts: 0, pendingBytes: 0, paused: false }),
      }
    }

    /** 展示回放存储：进程内实现（房主录制/广播，客机收片落库），只用于观测，不参与复现判据。 */
    function replayStorage(rounds: any[]) {
      return {
        saveRound: (round: any) => {
          const at = rounds.findIndex(item => item.roundIndex === round.roundIndex)
          if (at >= 0) rounds.splice(at, 1, round); else rounds.push(round)
        },
        saveMatch: () => {}, loadRounds: async () => rounds, loadMatch: async () => null,
      }
    }
    const replayRounds: any[][] = [[], []]
    const replayStores = [replayStorage(replayRounds[0]!), replayStorage(replayRounds[1]!)]

    const handlers = [[], []] as Array<Array<(message: unknown, from: string) => void>>
    const bindings = new Map([['human-0', 0], ['human-1', 1]])
    const rooms = [0, 1].map(seat => ({
      roomId: 'analysis-p2p-fixture', peerId: `human-${seat}`, hostId: 'human-0', isHost: seat === 0,
      onMessage: (handler: any) => handlers[seat]!.push(handler), onPeer: () => {},
      send: (message: unknown, target?: string) => {
        for (let recipient = 0; recipient < 2; recipient++) if (recipient !== seat && (!target || target === `human-${recipient}`)) {
          const data = structuredClone(message)
          queueMicrotask(() => handlers[recipient]!.forEach(handler => handler(data, `human-${seat}`)))
        }
      },
      peers: () => [{ id: `human-${1 - seat}`, open: true }],
    }))

    const modules = rooms.map((room, seat) => createBloodFlowRoom({
      getSeat: () => seat, getMode: () => 'east', getIsHost: () => seat === 0,
      getVerifiedBindings: () => bindings,
      getPlayerProfile: s => ({ name: `P${s}`, avatar: '', playerKind: s < 2 ? 'human' : 'bot' }),
      leave: () => {}, onError: error => evidence.errors.push(error), paceMs: 0,
      replayStorage: replayStores[seat] as any,
      // 房主那侧整体关掉分析（生产里对应 `analysis.port === null`）：不录制、不产出、不下发
      analysis: (seat === 0 && !hostAnalysis) ? null : analysisProxy(seat) as any,
      onAnalysisMatchId: detail => {
        if (seat === 0 && !hostAnalysis) return
        // 与 App 的 `analysis.start(...)` 同一件事：场次 id 由房间给（房主自己定、客机从帧里取）
        matchIds[seat] = detail.matchId
        const recorder = createAnalysisRecorder({ enabled: true, matchId: detail.matchId,
          rulesetId: 'lotus-blood-flow', storage: storages[seat],
          onError: detailText => evidence.warnings.push(`seat${seat}: ${String(detailText)}`) })
        recorder.beginMatch({
          engineBuild: 'e2e/analysis-p2p', rulesVersion: BLOOD_FLOW_CONFIG.version, rulesFingerprint: 'e2e',
          rules: BLOOD_FLOW_CONFIG as unknown as Record<string, unknown>, aiStrategy: 'source-v2',
          aiFingerprint: 'e2e', aiConfig: { local: BLOOD_FLOW_AI, llm: BLOOD_FLOW_LLM_AI } as unknown as Record<string, unknown>,
          seatControl: detail.seatControl,
        })
        recorders[seat] = recorder
      },
    }))

    const first = Promise.resolve({ initialWall: buildRingWall(seededRandom(87)),
      openingDice: [2, 3] as [number, number], openingSecondDice: [1, 4] as [number, number] })
    modules.forEach((module, index) => module.attach(rooms[index] as any, first, bindings))

    const sent = new Set<string>(), continued = new Set<string>()
    /** 逐局真实结束分数：结算帧的公开 roundResult（复现判据的期望值来源，不依赖展示回放）。 */
    const roundEndings: Array<Array<{ round: number; endingScores: number[] }>> = [[], []]
    const snapshotTimer = setInterval(() => {
      if (evidence.snapshots.length > 280) return
      evidence.snapshots.push(modules.map((module, seat) => {
        const view = module.port.view.value
        return `${seat}:${module.port.phase.value}/r${module.port.round.value}/${view?.public.status ?? '-'}`
          + `/win=${view?.window?.id?.split('/').pop() ?? '-'}/fin=${module.port.matchFinished.value ? 1 : 0}`
      }).join('  '))
    }, 1000)
    const timer = setInterval(() => {
      if (evidence.errors.length) { clearInterval(timer); clearInterval(snapshotTimer); modules.forEach(module => module.stop()); return }
      for (const [seat, module] of modules.entries()) {
        const port = module.port, view = port.view.value
        if (!view) continue
        if (port.phase.value === 'settled') {
          const result = view.public.roundResult
          if (result && !roundEndings[seat]!.some(item => item.round === port.round.value)) {
            roundEndings[seat]!.push({ round: port.round.value, endingScores: [...result.endingScores] })
          }
          const key = `${seat}:${view.roundId}`
          if (!continued.has(key)) {
            continued.add(key)
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
        else if (action.kind === 'chi') port.capabilities.value.chi.choose(view.ownActions.filter(a => a.kind === 'chi')
          .findIndex(a => JSON.stringify(a) === JSON.stringify(action)))
      }
      if (!modules.every(module => module.port.matchFinished.value)) return
      clearInterval(timer); clearInterval(snapshotTimer)
      void (async () => {
        for (const seat of hostAnalysis ? [0, 1] : [1]) {
          const recorder = recorders[seat], matchId = matchIds[seat], store = replayRounds[seat]!
          if (!recorder || !matchId) { evidence.errors.push(`座位 ${seat} 没有开出分析记录`); continue }
          // 场末收尾：与 App 一样先在房间侧把还在路上的复现数据结清，再结束会话并落库
          // （App 走的是同一个入口 `settleBloodFlowAnalysis()`，默认 6s 宽限）
          const settleStart = Date.now()
          await modules[seat]!.settleAnalysis()
          evidence.settleMs.push({ seat, ms: Date.now() - settleStart, diagnostics: recorder.diagnostics() })
          await recorder.finish()
          const stored = await storages[seat]!.read(matchId)
          const reproductions = stored.parts.filter((part: any) => part.tag === 'reproduction').map((part: any) => part.value)
          const verify = reproductions.filter((record: any) => record.available !== false).map((record: any) => {
            // 期望分数取"这一局结算时的公开结束分数"。**不用展示回放的逐局 final**：
            // 那属于另一个特性（回放录制），而且它的逐局边界自己就可能错位；
            // 复现判据要的是"权威宣布的这一局结果"，结算帧的 roundResult 就是那个口径。
            const expected = roundEndings[seat]!.find(item => item.round === record.roundIndex)?.endingScores ?? null
            const result = replayReproduction({ reproduction: record, commands: record.commands ?? [], expectedScores: expected })
            return { roundIndex: record.roundIndex, ok: result.ok, reason: result.reason, scoresMatch: result.scoresMatch,
              kindMismatches: result.kindMismatches, submitted: result.submitted, recorded: result.recorded,
              finalScores: result.finalScores, expectedScores: expected }
          })
          const decisions = stored.parts.filter((part: any) => part.tag === 'decision').map((part: any) => part.value)
          const tally = (values: string[]) => values.reduce<Record<string, number>>((all, value) => {
            all[value] = (all[value] ?? 0) + 1
            return all
          }, {})
          evidence.traces.push({ seat, trace: modules[seat]!.analysisTrace?.() ?? [] })
          evidence.sides.push({
            seat, matchId,
            records: reproductions.map((record: any) => ({
              roundIndex: record.roundIndex, available: record.available, origin: record.origin,
              unavailableReason: record.unavailableReason, dealer: record.dealer,
              commands: (record.commands ?? []).length, wallLength: (record.initialWall ?? []).length,
              handLengths: (record.initialHands ?? []).map((hand: string[]) => hand.length),
              openingScores: record.openingScores ?? [],
            })),
            gaps: stored.parts.filter((part: any) => part.tag === 'gaps').map((part: any) => part.value),
            verify,
            // 指纹只取私有复现数据本身（不含时间戳）：两端必须逐字一致
            digests: reproductions.map((record: any) => JSON.stringify([
              record.roundIndex, record.initialWall, record.initialHands, record.commands,
            ])),
            roundEndings: roundEndings[seat]!,
            replayRounds: store.map((round: any) => ({ roundIndex: round.roundIndex,
              scoresBefore: round.scoresBefore ?? null, finalScores: round.final?.scores ?? null })),
            decisionStats: {
              total: decisions.length,
              bySource: tally(decisions.map((decision: any) => String(decision.source))),
              byExecution: tally(decisions.map((decision: any) => String(decision.execution?.status ?? 'unknown'))),
              authorityAccepted: decisions.filter((decision: any) => decision.execution?.detail === 'authority-accepted').length,
            },
          })
        }
        evidence.done = true
        modules.forEach(module => module.stop())
      })()
    }, 10)
  })
  await page.waitForFunction(() => Boolean((window as any).__analysisP2pEvidence?.done), undefined, { timeout: 240_000 })
    .catch(() => {})
  const evidence = await page.evaluate(() => (window as any).__analysisP2pEvidence) as DriverEvidence
  console.log(`[analysis-p2p][diag] url=${page.url()} 快照数=${evidence.snapshots.length} 轨迹数=${evidence.traces.map(item => item.trace.length).join('/')}`
    + ` 两侧记录=${evidence.sides.map(side => `${side.seat}:${side.records.length}`).join(' ')} 用时ms=${Date.now() - driverStart}`)
  if (!evidence.done || evidence.errors.length) {
    console.log(`[analysis-p2p] 未完成=${!evidence.done}，快照尾部：\n  ${evidence.snapshots.slice(-10).join('\n  ')}`)
    console.log(`[analysis-p2p] 轨迹：\n  ${evidence.traces.flatMap(item => item.trace).join('\n  ')}`)
    console.log(`[analysis-p2p] 错误 ${JSON.stringify(evidence.errors)} 警告 ${JSON.stringify(evidence.warnings)}`)
  }
  return evidence
}

async function writeEvidence(name: string, payload: unknown): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  await mkdir(`${repoRoot}/tmp`, { recursive: true })
  await writeFile(`${repoRoot}/tmp/${name}`, JSON.stringify(payload, null, 2))
}

test('联机分析记录：房主局后下发复现数据，两端都能重跑到同一结束状态（§6、§10.6）', async ({ page }) => {
  const pageErrors = collectPageErrors(page)
  const evidence = await runDriver(page, '/')
  await writeEvidence('analysis-p2p.json', evidence)
  expect(pageErrors).toEqual([])
  expect(evidence.errors, '驱动与录制都不该报错').toEqual([])
  expect(evidence.done, '对局与场末收尾都应走完').toBe(true)

  for (const side of evidence.sides) {
    console.log(`[analysis-p2p] 座位 ${side.seat}：复现记录 ${side.records.length} 局，`
      + side.verify.map(item => `#${item.roundIndex} ${item.submitted}/${item.recorded}${item.ok ? ' ok' : ' ✗'}`).join('  '))
    for (const item of side.verify) if (!item.ok) console.log(`[analysis-p2p] 座位 ${side.seat} 第 ${item.roundIndex} 局失败：${item.reason}`)
    // 两端都必须在分析区里拿到**房主产出的**复现数据（客机自己算不出牌墙与对手暗手）
    const trace = evidence.traces.find(item => item.seat === side.seat)?.trace ?? []
    expect(side.records.length, `座位 ${side.seat} 应有 4 局的复现记录（轨迹：${trace.slice(-6).join(' | ')}）`).toBe(4)
    for (const record of side.records) {
      expect(record.available, `座位 ${side.seat} 第 ${record.roundIndex} 局的复现数据应可用`).toBe(true)
      expect(record.origin, `座位 ${side.seat} 第 ${record.roundIndex} 局的来源应是权威端`).toBe('authority')
      expect(record.wallLength, '复现数据必须带初始牌墙').toBe(81)
      // 庄家 14 张、其余 13 张；庄家逐局轮转（东1=座位0 …），不能钉死在某一家
      expect(record.handLengths, `座位 ${side.seat} 第 ${record.roundIndex} 局应带四家初始手牌`).toHaveLength(4)
      expect(record.handLengths[record.dealer], `座位 ${side.seat} 第 ${record.roundIndex} 局庄家应有 14 张`).toBe(14)
      expect(record.handLengths.filter((length: number) => length === 13), '其余三家应各 13 张').toHaveLength(3)
      expect(record.commands, '复现数据必须带完整权威命令序列').toBeGreaterThan(10)
      expect(record.openingScores.length).toBe(4)
    }
    expect(side.gaps.filter(gap => gap.scope === 'reproduction'), `座位 ${side.seat} 不该有复现数据缺口`).toEqual([])
    expect(side.roundEndings.length, `座位 ${side.seat} 应有 4 局的结算帧结束分数`).toBe(4)

    // §10.6：每一局都能重跑到同一结束状态
    for (const item of side.verify) {
      expect(item.expectedScores, `座位 ${side.seat} 第 ${item.roundIndex} 局应有可比对的期望分数`).not.toBeNull()
      expect(item.reason, `座位 ${side.seat} 第 ${item.roundIndex} 局：${item.reason}`).toBeNull()
      expect(item.ok, `座位 ${side.seat} 第 ${item.roundIndex} 局应复现成功`).toBe(true)
      expect(item.scoresMatch, `座位 ${side.seat} 第 ${item.roundIndex} 局结束分数应一致`).toBe(true)
      expect(item.kindMismatches, `座位 ${side.seat} 第 ${item.roundIndex} 局窗口类型不应错位`).toBe(0)
      expect(item.submitted).toBe(item.recorded)
    }
    // 跨局自洽：第 N 局重跑出来的结束分数，必须正好是第 N+1 局记录里的开局分数
    for (let index = 0; index < side.verify.length - 1; index += 1) {
      const next = side.records.find(record => record.roundIndex === side.verify[index]!.roundIndex + 1)
      expect(side.verify[index]!.finalScores, `座位 ${side.seat} 第 ${side.verify[index]!.roundIndex} 局的重跑结果应等于下一局的开局分数`)
        .toEqual(next?.openingScores)
    }
  }

  // 客机拿到的必须是房主产出的同一份（不是各算各的）
  expect(evidence.sides[1]!.digests).toEqual(evidence.sides[0]!.digests)

  // §3.2/§3.4：联机 AI 座位的决策与执行回执也真的入了账（房主侧）
  const host = evidence.sides.find(side => side.seat === 0)!
  const guest = evidence.sides.find(side => side.seat === 1)!
  console.log(`[analysis-p2p] 决策记录：房主 ${host.decisionStats.total} 条（来源 ${JSON.stringify(host.decisionStats.bySource)}，`
    + `回执 ${JSON.stringify(host.decisionStats.byExecution)}），客机 ${guest.decisionStats.total} 条`)
  expect(host.decisionStats.total, '房主应记录本家 + AI 座位的决策').toBeGreaterThan(guest.decisionStats.total)
  expect(guest.decisionStats.total, '客机至少要记录本家座位的决策').toBeGreaterThan(10)
  expect(host.decisionStats.byExecution.executed ?? 0, '房主侧应有执行回执').toBeGreaterThan(0)
  expect(host.decisionStats.authorityAccepted, '执行回执要写明判据来自权威').toBeGreaterThan(0)

  // 观测（不属于本用例的验收项）：展示回放的逐局边界若与真实局末分数不符，留档供回放特性复核
  for (const side of evidence.sides) {
    const mismatched = side.replayRounds.filter((round, index) =>
      JSON.stringify(round.finalScores) !== JSON.stringify(side.roundEndings[index]?.endingScores ?? null))
    if (mismatched.length) {
      console.log(`[analysis-p2p][观测] 座位 ${side.seat} 展示回放 ${side.replayRounds.length} 局，`
        + `其中 ${mismatched.length} 局的 final 与真实局末分数不一致（回放特性待复核，分析复现不依赖它）`)
    }
  }
})

// §6 的另一半：房主**没**开分析记录时，客机拿不到赛后私有数据 —— 必须如实记"未提供/未收到"，
// 而不是留一片空白，更不能拿本机视角猜一份（客机本就没有牌墙与对手暗手）。
test('联机分析记录：房主未开分析时，客机如实标记复现数据不可用（§6 的降级口径）', async ({ page }) => {
  const pageErrors = collectPageErrors(page)
  const evidence = await runDriver(page, '/?noHostAnalysis=1')
  await writeEvidence('analysis-p2p-degraded.json', evidence)
  expect(pageErrors).toEqual([])
  expect(evidence.errors, '驱动与录制都不该报错').toEqual([])
  expect(evidence.done, '对局与场末收尾都应走完').toBe(true)

  const guest = evidence.sides.find(side => side.seat === 1)!
  expect(evidence.sides.some(side => side.seat === 0), '房主没开分析，不该有房主的分析记录').toBe(false)
  console.log(`[analysis-p2p] 房主未开分析：客机复现记录 ${JSON.stringify(guest.records.map(record => [record.roundIndex, record.available]))}`)
  console.log(`[analysis-p2p] 客机轨迹：\n  ${(evidence.traces.find(item => item.seat === 1)?.trace ?? []).join('\n  ')}`)
  expect(guest.records.length, '客机仍应有 4 局的复现记录（如实标不可用）').toBe(4)
  for (const record of guest.records) {
    expect(record.available, `第 ${record.roundIndex} 局应如实标成不可用`).toBe(false)
    expect(record.wallLength, '不可用时不得带牌墙').toBe(0)
    expect(record.commands, '不可用时不得带命令序列').toBe(0)
    expect(String(record.unavailableReason), '必须写明原因').toMatch(/未在时限内收到|场末仍未收到|未提供|未开启/)
  }
  expect(guest.gaps.filter(gap => gap.scope === 'reproduction').length, '每个缺数据的局都要留痕').toBe(4)
})
