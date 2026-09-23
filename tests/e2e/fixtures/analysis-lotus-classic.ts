// 莲花广麻 P0+P1 分析记录的端到端探针（约定 §9 的 DoD；P1 见方案 §4）。
//
// 走**真实** useGame + 真实分析区（IndexedDB），但不经由 App.vue：
// 引擎侧的 `analysis` 选项已经就位，所以这里用**与 App 同一条路径**（同一个会话代理、同一个
// matchId、同一个 storage）驱动完整对局，把"数据层的判据"全部断言掉：
//   ① 开关开：记录落库 → parts 形状、行内状态、导出包自包含；
//   ② 开关关：零写入（库里不多一场、块数为 0）；
//   ③ 开/关两种设置下同一场（同一随机序列）的结束分数与动作数完全一致（硬护栏）；
//   ④ **P1**：从分析区读回复现数据 → 用 `ringWall + 骰子` 逐局重跑 ⇒ 命令逐条消费、
//      结束分数与记录一致（§4「整局重跑到同一结束状态」）；并做"改一张 postDealHands"的负向对照。
//
// 查询参数：
//   `?replay=0` 跳过逐局重跑（P0 的形状用例与开/关硬护栏不需要它，省一次全套重跑的时间）
//   `?seed=N`   固定整场每局的牌墙与骰子（P1 的确定性重跑需要；不给则用固定默认 seed）
import { useGame } from '../../../src/game/core/local/useGame'
import { createWall } from '../../../src/game/core/rules/tiles'
import { createAnalysisStorage, type AnalysisStorage } from '../../../src/game/replay/analysis/storage'
import { createAnalysisSession } from '../../../src/game/replay/analysis/session'
import { lotusClassicAnalysisConfig } from '../../../src/game/replay/analysis/lotusClassicConfig'
import { emptyLlmSettings } from '../../../src/game/llm/config'
import { analysisAreaLabel } from '../../../src/game/replay/analysis/status'
import { buildAnalysisExport } from '../../../src/game/replay/analysis/export'
import { decodeAnalysisBlock, utf8Bytes, type AnalysisBlockPart } from '../../../src/game/replay/analysis/codec'
import { createReplayRecorder } from '../../../src/game/replay/recorder'
// P1（§6）：赛后复现的校验器。它是**浏览器侧**模块（内部起真实 `useGame` 重跑一局），
// 所以只能在夹具页面里调用 —— 这也正是它必须在夹具里跑、而不是在 vitest 里跑的原因（§3.5）。
import { replayLotusClassicRound } from '../../../src/game/replay/analysis/reproduceLotusClassic'
import type { AnalysisReproduction } from '../../../src/game/replay/analysis/types'
import type { AnalysisRecorder } from '../../../src/game/replay/analysis/recorder'
import type { ReplayMatch, ReplayRecorderHooks, ReplayRound } from '../../../src/game/replay/types'

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
    exportMatchId: string | null
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
    /** 每个窗口的合法动作是否非空、选择 ID 是否落在那 个窗口的合法动作里。 */
    choicesResolvable: boolean
    /** 结算四家变化之和是否恒为 0。 */
    settlementsBalanced: boolean
    settlements: number
    /** 导出包：记录 + 被引用配置 + 展示回放都在，且没有缺失项。 */
    exportManifest: unknown
    exportBytes: number
    /** 导出包里 missing 的条目（P1 起应为空：复现数据也齐了）。 */
    exportMissing: string[]
    /** 导出包声明的"可复现"：P1 起按记录内容判定，字段齐了就应当是 true（§2.4）。 */
    exportReproductionCapable: boolean
    records: number
    configurations: number
    replayRounds: number
    /** P1：落库的复现数据条数（关掉分析时必须为 0 ⇒ 零成本）。 */
    reproductionParts: number
    /** P1：逐局重跑的结论（§4「整局重跑到同一结束状态」的机器可判据）。 */
    reproductionRounds: ReproductionRun[]
    /**
     * P1：把 `postDealHands` 改一张（只改顺序）之后的重跑结论。
     * 必须 `ok=false`、原因里带「发牌算法变了或记录与引擎不一致」，且 **一条命令都没消费**
     * （`commandsConsumed=0`）—— 这证明校验器是"停下来"，而不是拿另一副牌把这一局跑完了。
     */
    postDealTamper: { ok: boolean; reason: string | null; windowsOpened: number; commandsConsumed: number } | null
  }
}

/** 一局重跑的摘要（只留机器可判据与失败原因，不留整套状态）。 */
interface ReproductionRun {
  roundIndex: number
  ok: boolean
  reason: string | null
  scoresMatch: boolean | null
  expectedScores: number[] | null
  finalScores: number[]
  kindMismatches: number
  postDealChecked: boolean
  postDealOk: boolean
  openingChecked: boolean
  openingOk: boolean
  windowsOpened: number
  commandsRecorded: number
  commandsConsumed: number
  commandsNotLegalAtRecordTime: number
  withoutWindowId: number
  unusedCommands: number
  nonCommandEntries: number
  gaps: string[]
}

const status: ProbeStatus = {
  ready: false,
  error: null,
  errors: [],
  off: { finished: false, rounds: 0, steps: 0, events: 0, eventTrace: [], scores: [], matchesBefore: 0, matchesAfter: 0, blocksForMatch: 0 },
  on: {
    finished: false, rounds: 0, steps: 0, events: 0, eventTrace: [], scores: [],
    matchId: '', exportMatchId: null, status: null, label: '', partsByTag: {}, partsTotal: 0,
    windows: 0, choices: 0, receipts: 0, uniqueWindowIds: false, choicesResolvable: false,
    settlementsBalanced: false, settlements: 0,
    exportManifest: null, exportBytes: 0, exportMissing: [], exportReproductionCapable: false,
    records: 0, configurations: 0, replayRounds: 0,
    reproductionParts: 0, reproductionRounds: [], postDealTamper: null,
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

/**
 * 让出一个宏任务（用**真实**的 `setTimeout`，绕开上面的 0ms 压缩）。
 *
 * 为什么重跑要用真实定时器而不是被压过的：压缩会把引擎里"等 650ms 开局"之类的**顺序**压平，
 * 而我们恰恰要验证"同一副牌 + 同一条命令序列 ⇒ 同一结束状态"这件事在真实节奏下也成立。
 * P1 的单测（假时钟）覆盖的是"分叉"本身，这一层覆盖的是"真实浏览器定时器下也一样"。
 */
const tick = () => new Promise<void>((resolve) => { realSetTimeout(() => resolve(), 0) })

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
  startGame(mode?: string, options?: Record<string, unknown>): unknown
  /** 「继续」按钮的入口：`matchLifecycle.nextRound(startOptions)` 会把开局参数转交给 `startGame`。 */
  nextRound(options?: Record<string, unknown>): void
}

/**
 * 一局的**固定开局参数**（P1 §6 的重跑入口就是这两个）：洗好的环状牌墙 + 两粒骰子。
 *
 * 为什么要钉死它们：P1 的验收是"拿记录里的牌墙+骰子重跑一局、看是否到同一结束状态"，
 * 而重跑**只能**靠这两项确定性复现 —— 开局靠 `Math.random` 的话，重跑读到的记录虽然是真的，
 * 但"重跑成功"这件事就退化成"两次随机各跑了一局"。
 * 由 `(seed, round)` 哈希出来，所以整场每一局都不同、同一 seed 下两场又完全一样
 * （开关开/关那条硬护栏还需要这一点）。
 */
function roundStartOptions(round: number, wall: string[]) {
  const mix = (salt: number) => {
    let value = (Math.imul(wall.length, 2_654_435_761) ^ Math.imul(round, 40_503) ^ salt) >>> 0
    value = Math.imul(value ^ (value >>> 15), 2_246_822_519) >>> 0
    return value
  }
  const die = (salt: number) => (mix(salt) % 6) + 1
  return { initialWall: wall, openingDice: [die(1), die(2)] as [number, number] }
}

/** 环状牌墙 136 张，顺序由 `seed` 与局号决定（与引擎默认的 `shuffle(createWall())` 同一套多重集合）。 */
function ringWallFor(seed: number, round: number): string[] {
  let state = (seed ^ Math.imul(round + 1, 2_654_435_761)) >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
  const wall = createWall() as string[]
  for (let index = wall.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const left = wall[index]!
    wall[index] = wall[swap]!
    wall[swap] = left
  }
  return wall
}

/** 打满一整场「东风场」（驱动逻辑与 useGame.sim.test.ts 一致，只是定时器被压成 0ms）。 */
async function playMatch(
  analysis: AnalysisRecorder | null,
  replayHooks?: ReplayRecorderHooks,
  seed = 987_654_321,
): Promise<MatchOutcome> {
  seedRandom(seed)
  const trace = replayTrace(replayHooks)
  const game = useGame({
    playSound: () => {}, playSoundAndWait: async () => {},
    countdownEnabled: true,
    recorder: trace.hooks,
    analysis,
  }) as unknown as RunningGame
  // 每一局的开局参数都钉死（见 `roundStartOptions`）：P1 的重跑要能确定性复现这一局。
  const startPromise = game.startGame('east', roundStartOptions(1, ringWallFor(seed, 1)))
  const rounds: string[] = []
  let steps = 0
  // 浏览器里 0ms 定时器会被夹到 ~4ms，一步一个宏任务；用墙钟截止而不是步数，避免"截断得看不懂"。
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    steps += 1
    if (game.matchFinished.value || game.phase.value === 'finished') break
    if (game.phase.value === 'settled') {
      rounds.push(String(game.round.value))
      // 推进整场（真实 UI 上就是结算框的「继续」）：**下一局自己的**固定开局参数交给它。
      // `nextRound(startOptions)` 会把参数原样转交给 `startGame`（与展示回放夹具同一手法），
      // 所以每一局的牌墙与骰子都是确定的 —— P1 的重跑才有确定的输入可比。
      game.nextRound(roundStartOptions(rounds.length + 1, ringWallFor(seed, rounds.length + 1)))
      continue
    }
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
    // `?replay=0` 跳过逐局重跑（重跑要真起引擎跑完整局，是本文件最慢的一段）。
    const params = new URLSearchParams(location.search)
    const replayEnabled = params.get('replay') !== '0'
    const seedParam = Number(params.get('seed'))
    const seed = Number.isFinite(seedParam) && seedParam > 0 ? seedParam : 987_654_321

    // ── ① 开关关掉：与 App 同一条路径（给引擎的是会话代理），但一场都不该写进去 ──
    const offSession = createAnalysisSession({ enabled: false, storage, onError: (detail) => status.errors.push(`关：${detail}`) })
    const matchesBefore = await countMatches(storage)
    status.off = { ...await playMatch(offSession.port, undefined, seed), matchesBefore, matchesAfter: 0, blocksForMatch: 0 }
    await offSession.finish()
    status.off.matchesAfter = await countMatches(storage)
    status.off.blocksForMatch = (await readAnalysisDb()).parts.length

    // ── ② 开关打开：同一会话形状、固定 matchId，跑同一场 ──
    const session = createAnalysisSession({ enabled: true, storage, onError: (detail) => status.errors.push(`开：${detail}`) })
    // Keep analysis and display replay on the same match id, as the real App does.
    const replay = createReplayRecorder({
      sink: { saveMatch: () => {}, saveRound: () => {} },
      meta: () => ({
        rulesetId: 'lotus-classic', rulesetName: '莲花广麻', themeName: 'jade',
        humanSeat: 0, analysisRecorded: true,
      }),
    })
    const matchId = replay.ensureMatchId()
    session.start({
      matchId,
      rulesetId: 'lotus-classic',
      // 与 App 的 analysisSnapshotFor 同口径：P0 先记规则标识；完整规则正文待协调者的公共改动补齐
      ...lotusClassicAnalysisConfig(emptyLlmSettings(), false),
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
    const outcome = await playMatch(proxy, replay.hooks, seed)
    const replayMatch = replay.finishAuto() as ReplayMatch | null
    const replayRounds = replay.snapshot().rounds as ReplayRound[]
    await session.finish()

    const { parts, matches } = await readAnalysisDb()
    const partsByTag: Record<string, number> = {}
    for (const part of parts) partsByTag[part.tag] = (partsByTag[part.tag] ?? 0) + 1
    const meta = matches.find((entry) => entry.matchId === matchId) ?? null
    const storedStatus = (meta?.status as string | undefined) ?? null
    const configurations = await storage.readConfigs(matchId)
    const settlements = parts.filter((part) => part.tag === 'settlement').map((part) => part.value as {
      deltas: number[]; scoresAfter: number[]
    })
    const exported = replayMatch
      ? buildAnalysisExport({
        match: replayMatch, rounds: replayRounds, parts, configurations,
        status: (storedStatus ?? 'missing') as never,
      })
      : null

    const settings = {
      ...outcome,
      matchId: session.matchId(),
      exportMatchId: exported?.match.id ?? null,
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
      reproductionParts: 0,
      reproductionRounds: [] as ReproductionRun[],
      postDealTamper: null as ProbeStatus['on']['postDealTamper'],
    }
    status.on = settings

    // ── P1（§6）：从分析区读回**复现数据** → 在夹具里逐局重跑，看是否到达同一结束状态 ──
    //
    // 关键点：重跑用的是**落库读回**的那份记录（不是内存里的对象），因此它同时验证了
    // 编码/解码/落库/读回这一整条链路没有把复现数据弄丢或改形。
    if (replayEnabled) {
      const reproductionParts = parts.filter((part) => part.tag === 'reproduction')
      settings.reproductionParts = reproductionParts.length
      // 结束分数用**结算记录**里的 `scoresAfter`（每局最后一条）——那是"记录侧权威的结束状态"。
      const scoresByRound = new Map<number, number[]>()
      for (const part of parts.filter((entry) => entry.tag === 'settlement')) {
        const record = part.value as { roundIndex?: number; scoresAfter?: number[] }
        if (typeof record.roundIndex === 'number' && Array.isArray(record.scoresAfter)) {
          scoresByRound.set(record.roundIndex, record.scoresAfter)
        }
      }
      const records = reproductionParts
        .map((part) => part.value as AnalysisReproduction)
        .sort((a, b) => a.roundIndex - b.roundIndex)
      for (const record of records) {
        const run = await replayLotusClassicRound({
          reproduction: record,
          // **原样**把命令日志交出去（不在这里按 `resolution` 预过滤）：跳过哪些条目必须由校验器
          // 自己计数并如实报出来（§4「被拒动作不出现」/「不许跳过命令」）——
          // 上游过滤会让"记录里混进了 bloodFlow 口径的条目"这种事悄悄消失。
          commands: record.commands ?? [],
          expectedScores: scoresByRound.get(record.roundIndex) ?? null,
          tick,
        })
        settings.reproductionRounds.push({
          roundIndex: run.roundIndex, ok: run.ok, reason: run.reason,
          scoresMatch: run.scoresMatch, expectedScores: run.expectedScores, finalScores: run.finalScores,
          kindMismatches: run.kindMismatches,
          postDealChecked: run.postDealCheck.checked, postDealOk: run.postDealCheck.ok,
          openingChecked: run.openingCheck.checked, openingOk: run.openingCheck.ok,
          windowsOpened: run.metrics.windowsOpened, commandsRecorded: run.metrics.commandsRecorded,
          commandsConsumed: run.metrics.commandsConsumed,
          commandsNotLegalAtRecordTime: run.metrics.commandsNotLegalAtRecordTime,
          withoutWindowId: run.metrics.withoutWindowId, unusedCommands: run.metrics.unusedCommands,
          nonCommandEntries: run.metrics.nonCommandEntries,
          gaps: run.gaps,
        })
      }
      // 交叉校验的**负向**证据（§3.3）：把第 1 局的 postDealHands 动一张（把首张挪到末尾：
      // **牌的多重集合没变、只有顺序变了**），校验器必须报"不一致"并且**一条命令都不喂**。
      // 用"顺序变了"而不是"换一张牌"是刻意的：它同时证明这道闸不是按集合比的。
      const first = records[0]
      if (first?.postDealHands?.[0] && first.postDealHands[0]!.length > 1) {
        const tampered: AnalysisReproduction = {
          ...first,
          postDealHands: first.postDealHands.map((hand, seat) => (
            seat === 0 ? [...hand.slice(0, -1), hand[0]!] : [...hand]
          )),
        }
        const run = await replayLotusClassicRound({
          reproduction: tampered, commands: first.commands ?? [], expectedScores: null, tick,
        })
        settings.postDealTamper = {
          ok: run.ok, reason: run.reason,
          windowsOpened: run.metrics.windowsOpened, commandsConsumed: run.metrics.commandsConsumed,
        }
      }
    }
    status.ready = true
  } catch (error) {
    status.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  }
})()
