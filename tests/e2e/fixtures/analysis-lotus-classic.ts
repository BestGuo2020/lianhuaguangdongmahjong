// 莲花广麻 P0 分析记录的端到端探针（约定 §9 的 DoD）。
//
// 走**真实** useGame + 真实分析区（IndexedDB），但不经由 App.vue：App 里那一行
// `analysis: analysis.port` 属于冻结清单，由协调者的「公共改动」提交补上（见
// docs/blood-flow/design/analysis-lotus-classic.md 的「未接线部分」）。引擎侧的
// `analysis` 选项已经就位，所以这里用**与 App 同一条路径**（同一个会话代理、同一个
// matchId、同一个 storage）驱动完整对局，把"数据层的判据"全部断言掉：
//   ① 开关开：记录落库 → parts 形状、行内状态、导出包自包含；
//   ② 开关关：零写入（库里不多一场、块数为 0）；
//   ③ 开/关两种设置下同一场（同一随机序列）的结束分数与动作数完全一致（硬护栏）。
import { useGame } from '../../../src/game/core/local/useGame'
import { createAnalysisStorage, type AnalysisStorage } from '../../../src/game/replay/analysis/storage'
import { createAnalysisSession } from '../../../src/game/replay/analysis/session'
import { analysisAreaLabel } from '../../../src/game/replay/analysis/status'
import { buildAnalysisExport } from '../../../src/game/replay/analysis/export'
import { decodeAnalysisBlock, utf8Bytes, type AnalysisBlockPart } from '../../../src/game/replay/analysis/codec'
import { createReplayRecorder } from '../../../src/game/replay/recorder'
import type { AnalysisRecorder } from '../../../src/game/replay/analysis/recorder'
import type { ReplayMatch, ReplayRecorderHooks, ReplayRound } from '../../../src/game/replay/types'

const MATCH_ID = 'e2e-lotus-classic'

interface MatchOutcome {
  finished: boolean
  rounds: number
  /** 主循环让出的宏任务次数（诊断用：对局是否卡住）。 */
  steps: number
  /** 展示回放事件轨迹：用它当"动作数"的指纹（与分析记录完全独立）。 */
  events: number
  eventTrace: string[]
  scores: number[]
}

interface ProbeStatus {
  ready: boolean
  error: string | null
  errors: string[]
  /** 开关关掉那一场：零写入 + 对局结果。 */
  off: MatchOutcome & { matchesBefore: number; matchesAfter: number; blocksForMatch: number }
  /** 开关打开那一场：记录内容 + 落库判据。 */
  on: MatchOutcome & {
    matchId: string
    status: string | null
    /** 用真实 analysisAreaLabel 判定的行内文案（等价于列表行「分析：完整」）。 */
    label: string
    partsByTag: Record<string, number>
    partsTotal: number
    /** 记录的窗口/选择/回执条数（由端口代理直接数的调用次数）。 */
    windows: number
    choices: number
    receipts: number
    uniqueWindowIds: boolean
    /** 每个窗口的合法动作是否非空、选择 ID 是否落在该窗口的合法动作里。 */
    choicesResolvable: boolean
    /** 结算四家变化之和是否恒为 0。 */
    settlementsBalanced: boolean
    settlements: number
    /** 导出包：记录 + 被引用配置 + 展示回放都在，且没有缺失项。 */
    exportManifest: unknown
    exportBytes: number
    /** 导出包里 missing 的条目（P0 没有复现数据，应只剩 reproduction 这一条）。 */
    exportMissing: string[]
    /** 导出包声明的"可复现"：P0 不做赛后复现，必须是 false（§6 是 P1）。 */
    exportReproductionCapable: boolean
    records: number
    configurations: number
    replayRounds: number
  }
}

const status: ProbeStatus = {
  ready: false,
  error: null,
  errors: [],
  off: { finished: false, rounds: 0, steps: 0, events: 0, eventTrace: [], scores: [], matchesBefore: 0, matchesAfter: 0, blocksForMatch: 0 },
  on: {
    finished: false, rounds: 0, steps: 0, events: 0, eventTrace: [], scores: [],
    matchId: '', status: null, label: '', partsByTag: {}, partsTotal: 0,
    windows: 0, choices: 0, receipts: 0, uniqueWindowIds: false, choicesResolvable: false,
    settlementsBalanced: false, settlements: 0,
    exportManifest: null, exportBytes: 0, exportMissing: [], exportReproductionCapable: false,
    records: 0, configurations: 0, replayRounds: 0,
  },
}
;(window as unknown as { __analysisClassic: ProbeStatus }).__analysisClassic = status

// 与其它 fixture 同一套节奏压缩：所有定时器 0ms，整场几秒跑完。
// setInterval 也要压：本家座位靠回合倒计时自动出牌/过牌，只压 setTimeout 会让对局停在人类回合。
const realSetTimeout = window.setTimeout.bind(window)
const realSetInterval = window.setInterval.bind(window)
window.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => (
  realSetTimeout(handler as never, 0, ...args)
)) as typeof window.setTimeout
window.setInterval = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => (
  realSetInterval(handler as never, 0, ...args)
)) as typeof window.setInterval

/** 确定性伪随机：开关开/关两场用同一序列 ⇒ 同一牌墙、同一骰子、同一 AI 选择。 */
function seedRandom(seed = 987_654_321) {
  let state = seed >>> 0
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/**
 * 展示回放事件轨迹：与分析记录完全独立的"动作数"口径。
 * `inner` 是真正的展示回放录制器（导出包要用它的场次与各局）；两个都要，所以串起来而不是二选一。
 */
function replayTrace(inner?: ReplayRecorderHooks) {
  const events: string[] = []
  const hooks: ReplayRecorderHooks = {
    roundStart: (frame) => { events.push(`round:${frame.round}`); inner?.roundStart(frame) },
    draw: (event, frame) => { events.push(`draw:${event.seat}:${event.tile}`); inner?.draw(event, frame) },
    discard: (event, frame) => { events.push(`discard:${event.seat}:${event.tile}`); inner?.discard(event, frame) },
    tableAction: (event, frame) => {
      events.push(`action:${event.type}:${event.actorIndex}:${event.tile}`)
      inner?.tableAction(event, frame)
    },
    roundEnd: (result, frame) => {
      events.push(`end:${result.draw ? 'draw' : result.winnerIndex}`)
      inner?.roundEnd(result, frame)
    },
  }
  return { hooks, events }
}

interface RunningGame {
  phase: { value: string }
  matchFinished: { value: boolean }
  round: { value: number }
  players: Array<{ score: number }>
  startGame(mode?: string): unknown
  nextRound(): void
}

/** 打满一整场「东风场」（驱动逻辑与 useGame.sim.test.ts 一致，只是定时器被压成 0ms）。 */
async function playMatch(analysis: AnalysisRecorder | null, replayHooks?: ReplayRecorderHooks): Promise<MatchOutcome> {
  seedRandom()
  const trace = replayTrace(replayHooks)
  const game = useGame({
    playSound: () => {}, playSoundAndWait: async () => {},
    countdownEnabled: true,
    recorder: trace.hooks,
    analysis,
  }) as unknown as RunningGame
  const startPromise = game.startGame('east')
  const rounds: string[] = []
  let steps = 0
  // 浏览器里 0ms 定时器会被夹到 ~4ms，一步一个宏任务；用墙钟截止而不是步数，避免"截断得看不懂"。
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    steps += 1
    if (game.matchFinished.value || game.phase.value === 'finished') break
    if (game.phase.value === 'settled') { rounds.push(String(game.round.value)); game.nextRound(); continue }
    if (game.phase.value === 'lobby') break
    await new Promise<void>((resolve) => { realSetTimeout(() => resolve(), 0) })
  }
  await startPromise
  return {
    finished: game.matchFinished.value || game.phase.value === 'finished',
    rounds: rounds.length,
    steps,
    events: trace.events.length,
    eventTrace: trace.events,
    scores: game.players.map((player) => player.score),
  }
}

/** 直接读分析库：块（解码成记录）与场次元数据。 */
async function readAnalysisDb(): Promise<{ parts: AnalysisBlockPart[]; matches: Array<Record<string, unknown>> }> {
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open('lianhua-guangma-analysis')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
  if (!db) return { parts: [], matches: [] }
  const readAll = async <T,>(store: string): Promise<T[]> => new Promise<T[]>((resolve) => {
    const tx = db.transaction(store, 'readonly')
    const request = tx.objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => resolve([])
  })
  const blocks = await readAll<{
    matchId: string; sequence: number; codec: 'gzip' | 'raw'; rawBytes: number
    storedBytes: number; parts: number; checksum: string; payload: Uint8Array
  }>('blocks')
  const matches = await readAll<Record<string, unknown>>('matches')
  db.close()
  const parts: AnalysisBlockPart[] = []
  for (const block of blocks.sort((a, b) => a.sequence - b.sequence)) {
    const decoded = await decodeAnalysisBlock({
      sequence: block.sequence, codec: block.codec, rawBytes: block.rawBytes,
      storedBytes: block.storedBytes, checksum: block.checksum, parts: block.parts,
      payload: new Uint8Array(block.payload),
    })
    if (decoded.parts) parts.push(...decoded.parts)
  }
  return { parts, matches }
}

const countMatches = async (storage: AnalysisStorage) => (await storage.usage()).matches

void (async () => {
  try {
    const storage = createAnalysisStorage()

    // ── ① 开关关掉：与 App 同一条路径（给引擎的是会话代理），但一场都不该写进去 ──
    const offSession = createAnalysisSession({ enabled: false, storage, onError: (detail) => status.errors.push(`关：${detail}`) })
    const matchesBefore = await countMatches(storage)
    status.off = { ...await playMatch(offSession.port), matchesBefore, matchesAfter: 0, blocksForMatch: 0 }
    await offSession.finish()
    status.off.matchesAfter = await countMatches(storage)
    status.off.blocksForMatch = (await readAnalysisDb()).parts.length

    // ── ② 开关打开：同一会话形状、固定 matchId，跑同一场 ──
    const session = createAnalysisSession({ enabled: true, storage, onError: (detail) => status.errors.push(`开：${detail}`) })
    session.start({
      matchId: MATCH_ID,
      rulesetId: 'lotus-classic',
      // 与 App 的 analysisSnapshotFor 同口径：P0 先记规则标识；完整规则正文待协调者的公共改动补齐
      rules: { id: 'lotus-classic' },
      rulesVersion: 'lotus-classic',
      aiConfig: null,
      aiStrategy: 'source-v2',
      seatControl: ['human', 'local-ai', 'local-ai', 'local-ai'],
      engineBuild: 'e2e-analysis-lotus-classic',
    })
    // 端口代理：只读监听，数调用次数并核对"选择的 ID 落在该窗口的合法动作里"。
    const port = session.port
    const windows = new Map<string, string[]>()
    let choices = 0
    let receipts = 0
    let choicesResolvable = true
    const proxy: AnalysisRecorder = {
      ...port,
      get enabled() { return port.enabled },
      windowOpened: (input) => {
        windows.set(`${input.windowId}#${input.seat}`, (input.state.legalActions ?? []).map((action) => action.id))
        return port.windowOpened(input)
      },
      chosen: (input) => {
        choices += 1
        const legal = windows.get(`${input.windowId}#${input.seat}`)
        if (!legal || legal.length === 0) choicesResolvable = false
        else if (input.legalActionId !== null && !legal.includes(input.legalActionId)) choicesResolvable = false
        return port.chosen(input)
      },
      receipt: (input) => { receipts += 1; return port.receipt(input) },
    }
    // 展示回放：内存 sink（探针不测回放库），只为导出包提供"记录 + 展示回放"两半
    const replay = createReplayRecorder({
      sink: { saveMatch: () => {}, saveRound: () => {} },
      meta: () => ({
        rulesetId: 'lotus-classic', rulesetName: '莲花广麻', themeName: 'jade',
        humanSeat: 0, analysisRecorded: true,
      }),
    })
    const outcome = await playMatch(proxy, replay.hooks)
    const replayMatch = replay.finishAuto() as ReplayMatch | null
    const replayRounds = replay.snapshot().rounds as ReplayRound[]
    await session.finish()

    const { parts, matches } = await readAnalysisDb()
    const partsByTag: Record<string, number> = {}
    for (const part of parts) partsByTag[part.tag] = (partsByTag[part.tag] ?? 0) + 1
    const meta = matches.find((entry) => entry.matchId === MATCH_ID) ?? null
    const storedStatus = (meta?.status as string | undefined) ?? null
    const configurations = await storage.readConfigs(MATCH_ID)
    const settlements = parts.filter((part) => part.tag === 'settlement').map((part) => part.value as {
      deltas: number[]; scoresAfter: number[]
    })
    const exported = replayMatch
      ? buildAnalysisExport({
        match: replayMatch, rounds: replayRounds, parts, configurations,
        status: (storedStatus ?? 'missing') as never,
      })
      : null

    status.on = {
      ...outcome,
      matchId: session.matchId(),
      status: storedStatus,
      label: analysisAreaLabel({ analysisRecorded: true }, (storedStatus ?? undefined) as never),
      partsByTag,
      partsTotal: parts.length,
      windows: windows.size,
      choices,
      receipts,
      uniqueWindowIds: new Set([...windows.keys()].map((key) => key.split('#')[0])).size === windows.size
        && windows.size > 0,
      choicesResolvable,
      settlementsBalanced: settlements.every((settlement) => settlement.deltas.reduce((sum, delta) => sum + delta, 0) === 0),
      settlements: settlements.length,
      exportManifest: exported?.manifest ?? null,
      exportBytes: exported ? utf8Bytes(JSON.stringify(exported)) : 0,
      exportMissing: (exported?.manifest?.missing ?? []) as string[],
      exportReproductionCapable: Boolean(exported?.reproductionCapable),
      records: exported?.manifest?.recordsTotal ?? 0,
      configurations: exported?.manifest?.configurations ?? 0,
      replayRounds: exported?.manifest?.replayRounds ?? 0,
    }
    status.ready = true
  } catch (error) {
    status.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  }
})()