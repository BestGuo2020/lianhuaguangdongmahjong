// §10.6 专用探针：只跑一场血流（真实 useBloodFlowGame + 真实 worker + 真实分析录制），
// 把**完整分析记录**（每局的 reproduction 载荷，含每条命令的窗口归属与窗口类型）连同权威端
// 的窗口轨迹一起导出，供离线逐条比对。
//
// 与 tests/e2e/fixtures/replay.ts 的区别：只跑血流一场、不落展示回放库、多导出诊断字段，
// 因此迭代一次只要几十秒（整条 replay.spec 要跑三场 + 整个回放 UI 用例）。
import { useBloodFlowGame } from '../../../src/game/variants/lotus/bloodFlow/useBloodFlowGame'
import { createAnalysisStorage } from '../../../src/game/replay/analysis/storage'
import { createAnalysisSession } from '../../../src/game/replay/analysis/session'
import { replayReproduction } from '../../../src/game/replay/analysis/replayReproduction'
import { buildCapacityReport, formatCapacityReport } from '../../../src/game/replay/analysis/capacity'
import { buildAnalysisExport } from '../../../src/game/replay/analysis/export'
import { decodeAnalysisBlock, utf8Bytes, type AnalysisBlockPart } from '../../../src/game/replay/analysis/codec'
import { createReplayRecorder } from '../../../src/game/replay/recorder'
import { buildRingWall } from '../../../src/game/variants/lotus/lotusWall'
import { seededRandom } from '../../../src/game/variants/lotus/bloodFlow/simulation'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_AI } from '../../../src/game/variants/lotus/bloodFlow/config'
import type { AnalysisReproduction } from '../../../src/game/replay/analysis/types'
import type { ReplayMatch, ReplayRound } from '../../../src/game/replay/types'

interface ProbeReplay {
  ok: boolean
  reason: string | null
  submitted: number
  recorded: number
  kindMismatches: number
  scoresMatch: boolean | null
  finalScores: number[]
  /** §11 推进来源：expire 应用／丢弃数、无窗口归属条目数。 */
  metrics: { expireApplied: number; expireSkippedByNumber: number; expireSkippedByFilter: number; withoutWindowId: number }
}

interface ProbeRound {
  roundIndex: number
  endingScores: number[] | null
  record: AnalysisReproduction
  /** 条目统计：来源计数、无窗口归属条目的数量、窗口编号 → 记录侧 kind。 */
  entries: {
    total: number
    resolutions: Record<string, number>
    withoutWindowId: number
    withoutWindowKind: number
    perWindow: Array<{ no: number; kinds: string[]; entries: string[] }>
  }
  replay: ProbeReplay | null
}

interface ProbeStatus {
  ready: boolean
  error: string | null
  errors: string[]
  rounds: ProbeRound[]
  /** 权威端窗口轨迹（主线程每次看到的新窗口）：id|kind|等待座位。 */
  windowTrace: string[]
  /** 主线程调用分析端口的顺序轨迹（窗口与前态是否齐全，只作参照）。 */
  callTrace: string[]
  timings: { playMs: number; replayMs: number }
  /** 本次对局的模式与种子（容量基线要求固定输入）。 */
  mode: 'east' | 'hanchan'
  seed: number | null
  /** 本场分析区的场次 id（跨页测试要按它删/读）。 */
  matchId: string
  /** 展示回放各局 JSON 的 UTF-8 字节合计（容量报告用；未计 IDB 开销）。 */
  replayBytes: number | null
  /** 容量报告（§9.1、§10.11）与其人读文本；由真实读数构建。 */
  capacityReport: unknown | null
  capacityText: string | null
}

const status: ProbeStatus = {
  ready: false, error: null, errors: [], rounds: [], windowTrace: [], callTrace: [], timings: { playMs: 0, replayMs: 0 },
  mode: 'east', seed: null, matchId: '', replayBytes: null, capacityReport: null, capacityText: null,
}
;(window as unknown as { __analysisProbe: ProbeStatus }).__analysisProbe = status

// 与 replay fixture 同一套节奏压缩：所有定时器 0ms，整场几秒跑完。
const realSetTimeout = window.setTimeout.bind(window)
const realSetInterval = window.setInterval.bind(window)
window.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => (
  realSetTimeout(handler as never, 0, ...args)
)) as typeof window.setTimeout
window.setInterval = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => (
  realSetInterval(handler as never, 0, ...args)
)) as typeof window.setInterval

const tick = (ms = 0) => new Promise<void>((resolve) => { realSetTimeout(() => resolve(), ms) })

/** 固定牌墙开局（容量基线要求输入可复算）。 */
function startWithSeed(
  game: { startGame(mode: 'east' | 'hanchan', options: Record<string, unknown>): unknown },
  mode: 'east' | 'hanchan',
  seed: number,
) {
  return game.startGame(mode, {
    initialWall: buildRingWall(seededRandom(seed)),
    openingDice: [2, 3],
    openingSecondDice: [1, 4],
  })
}

/** 采集容量报告：分块字节、应用账本、场次元数据、浏览器估算与持久化状态（§9.1）。 */
async function collectCapacityReport(
  storage: ReturnType<typeof createAnalysisStorage>,
  snapshot: { match: ReplayMatch | null; rounds: ReplayRound[] },
): Promise<{ report: unknown; text: string }> {
  const open = () => new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open('lianhua-guangma-analysis')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
  const db = await open()
  const readAll = async <T,>(store: string): Promise<T[]> => {
    if (!db) return []
    return new Promise<T[]>((resolve) => {
      const tx = db.transaction(store, 'readonly')
      const request = tx.objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result as T[])
      request.onerror = () => resolve([])
    })
  }
  const blocks = await readAll<{ sequence: number; codec: 'gzip' | 'raw'; rawBytes: number; storedBytes: number; parts: number; checksum: string; payload: Uint8Array }>('blocks')
  const metas = await readAll<Record<string, unknown>>('matches')
  db?.close()
  // 解码记录：容量口径里"记录条数/JSON 字节"必须是解码后的原文，不是压缩块
  const parts: AnalysisBlockPart[] = []
  for (const block of blocks.sort((a, b) => a.sequence - b.sequence)) {
    const decoded = await decodeAnalysisBlock({
      sequence: block.sequence, codec: block.codec, rawBytes: block.rawBytes,
      storedBytes: block.storedBytes, checksum: block.checksum, parts: block.parts, payload: new Uint8Array(block.payload),
    })
    if (decoded.parts) parts.push(...decoded.parts)
  }
  const usage = await storage.usage()
  const matchId = snapshot.match?.id ?? (metas[0]?.matchId as string | undefined)
  const configurations = matchId ? await storage.readConfigs(matchId) : []
  // 导出包：走与界面同一条构建路径（自包含：记录 + 配置 + 展示回放），量它的 UTF-8 字节
  const exportPayload = snapshot.match
    ? buildAnalysisExport({ match: snapshot.match, rounds: snapshot.rounds, parts, configurations, status: 'complete' })
    : null
  let estimate: { usage: number; quota: number } | null = null
  try {
    const reading = await navigator.storage?.estimate?.()
    if (reading && typeof reading.usage === 'number' && typeof reading.quota === 'number') {
      estimate = { usage: reading.usage, quota: reading.quota }
    }
  } catch { /* 估算接口不可用：报告里记「不可得」 */ }
  const report = buildCapacityReport({
    parts,
    blocks: blocks.map(block => ({
      sequence: block.sequence, codec: block.codec, rawBytes: block.rawBytes, storedBytes: block.storedBytes, parts: block.parts,
    })),
    ledger: { bytes: usage.bytes, matches: usage.matches },
    rounds: snapshot.rounds.length,
    metas,
    exportBytes: exportPayload ? utf8Bytes(JSON.stringify(exportPayload)) : null,
    replayBytes: utf8Bytes(JSON.stringify(snapshot.rounds)),
    estimate,
    persistence: `${storage.capability().snapshot().persistence}`,
  })
  return { report: JSON.parse(JSON.stringify(report)) as unknown, text: formatCapacityReport(report) }
}

void (async () => {
  try {
    const params = new URLSearchParams(location.search)
    const mode: 'east' | 'hanchan' = params.get('mode') === 'hanchan' ? 'hanchan' : 'east'
    const seedParam = Number(params.get('seed'))
    const seed = Number.isFinite(seedParam) && seedParam > 0 ? seedParam : null
    status.mode = mode
    status.seed = seed
    const storage = createAnalysisStorage()
    const session = createAnalysisSession({
      enabled: true, storage,
      onError: (detail) => status.errors.push(`分析记录：${detail}`),
    })
    session.start({
      rulesetId: 'lotus-blood-flow',
      rules: BLOOD_FLOW_CONFIG,
      rulesVersion: BLOOD_FLOW_CONFIG.version,
      aiConfig: { local: BLOOD_FLOW_AI },
      aiStrategy: 'source-v2',
      seatControl: ['human', 'local-ai', 'local-ai', 'local-ai'],
      engineBuild: 'e2e-analysis-probe',
    })
    // 端口代理：只读监听，捕捉每局的 reproduction 载荷（与落库同一份数据）与调用顺序。
    const captured: Array<{ roundIndex: number; record: AnalysisReproduction }> = []
    const port = session.port!
    const proxy = {
      ...port,
      get enabled() { return port.enabled },
      windowOpened: (input: Parameters<typeof port.windowOpened>[0]) => {
        if (status.callTrace.length < 400) status.callTrace.push(`open ${input.windowId} seat=${input.seat} kind=${input.windowKind}`)
        return port.windowOpened(input)
      },
      reproduction: (input: AnalysisReproduction) => {
        captured.push({ roundIndex: input.roundIndex, record: JSON.parse(JSON.stringify(input)) as AnalysisReproduction })
        status.callTrace.push(`reproduction round=${input.roundIndex} commands=${input.commands?.length ?? 0}`)
        return port.reproduction(input)
      },
    }
    // 展示回放录制器：不落库（探针不测展示回放库），只用来量"展示回放有多大"（§9.1 要求分开记账）
    const recorder = createReplayRecorder({
      sink: { saveMatch: () => {}, saveRound: () => {} },
      meta: () => ({ rulesetId: 'lotus-blood-flow', rulesetName: '莲花麻将·血流', themeName: 'llm', humanSeat: 0 }),
    })
    const game = useBloodFlowGame({
      playSound: () => {}, playSoundAndWait: async () => {},
      countdownEnabled: true, autoplay: true, paceMs: 0,
      recorder: recorder.hooks,
      analysis: proxy as never,
    }) as unknown as {
      phase: { value: string }
      matchFinished: { value: boolean }
      round: { value: number }
      startGame(mode?: 'east' | 'hanchan'): unknown
      nextRound(): void
      view: { value: { window?: { id: string; kind: string } | null; waitingSeats?: number[]; public: { roundResult?: { endingScores: number[] } | null } } | null }
    }

    const roundScores = new Map<number, number[]>()
    let lastWindow = ''
    const poll = () => {
      const current = game.view.value
      const window = current?.window
      if (window) {
        const line = `${window.id}|${window.kind}|[${(current?.waitingSeats ?? []).join(',')}]`
        if (line !== lastWindow) { lastWindow = line; status.windowTrace.push(line) }
      }
      const result = current?.public.roundResult
      if (result) roundScores.set(game.round.value, [...result.endingScores])
    }
    const poller = realSetInterval(poll, 0)

    const playStart = performance.now()
    // 固定输入：给了 seed 就用固定牌墙（容量基线要求"同一次真实半庄"可复算）
    await (seed === null ? game.startGame(mode) : startWithSeed(game, mode, seed))
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      poll()
      if (game.matchFinished.value || game.phase.value === 'finished') break
      if (game.phase.value === 'settled') {
        if (seed === null) game.nextRound()
        else game.nextRound({ initialWall: buildRingWall(seededRandom(seed + game.round.value)), openingDice: [2, 3], openingSecondDice: [1, 4] })
        await tick()
        continue
      }
      if (game.phase.value === 'lobby') throw new Error('对局回到大厅，未打完')
      await tick()
    }
    status.timings.playMs = Math.round(performance.now() - playStart)
    realSetInterval(poller as never, 0)
    if (!game.matchFinished.value && game.phase.value !== 'finished') status.errors.push(`对局未打完：phase=${game.phase.value}`)
    // 收尾展示回放录制器（内存 sink）：拿到场次记录与各局内容，用于量"展示回放有多大"与导出包字节
    const replayMatch = recorder.finishAuto()
    const replaySnapshot = { match: replayMatch, rounds: recorder.snapshot().rounds }
    status.replayBytes = utf8Bytes(JSON.stringify(replaySnapshot.rounds))
    await session.finish()
    const capacity = await collectCapacityReport(storage, replaySnapshot)
    status.capacityReport = capacity.report
    status.capacityText = capacity.text

    // 逐局回放：把真实录像喂回引擎，比对权威端的结束分数（比"展示回放快照"更硬的判据）。
    const replayStart = performance.now()
    for (const { roundIndex, record } of captured) {
      const commands = record.commands ?? []
      const result = replayReproduction({
        reproduction: record, commands,
        ...(roundScores.has(roundIndex) ? { expectedScores: roundScores.get(roundIndex)! } : {}),
      })
      const resolutions: Record<string, number> = {}
      const perWindow = new Map<number, { kinds: Set<string>; entries: string[] }>()
      let withoutWindowId = 0
      let withoutWindowKind = 0
      for (const command of commands) {
        const key = command.resolution ?? 'command'
        resolutions[key] = (resolutions[key] ?? 0) + 1
        if (!command.windowId) { withoutWindowId += 1; continue }
        if (!command.windowKind) withoutWindowKind += 1
        const no = Number(command.windowId.split('/').pop())
        const bucket = perWindow.get(no) ?? { kinds: new Set<string>(), entries: [] }
        if (command.windowKind) bucket.kinds.add(command.windowKind)
        bucket.entries.push(`${command.seat}:${command.kind}${command.resolution ? `(${command.resolution})` : ''}${command.windowKind ? `[${command.windowKind}]` : ''}`)
        perWindow.set(no, bucket)
      }
      status.rounds.push({
        roundIndex,
        endingScores: roundScores.get(roundIndex) ?? null,
        record,
        entries: {
          total: commands.length, resolutions, withoutWindowId, withoutWindowKind,
          perWindow: [...perWindow].sort((a, b) => a[0] - b[0])
            .map(([no, bucket]) => ({ no, kinds: [...bucket.kinds], entries: bucket.entries })),
        },
        replay: result,
      })
    }
    status.timings.replayMs = Math.round(performance.now() - replayStart)
    status.matchId = session.matchId()
    status.ready = true
  } catch (error) {
    status.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  }
})()
