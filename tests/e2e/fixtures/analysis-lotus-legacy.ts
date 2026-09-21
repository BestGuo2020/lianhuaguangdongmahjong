// 「莲花麻将·翻精癞子」分析记录的专用夹具：真实 `useLotusGame` + 真实分析录制 + 真实 IndexedDB 分析区。
//
// 为什么不用真实 App：`src/App.vue` 在协调者的冻结清单里（约定 §3），给 `useLotusGame` 传
// `analysis: analysis.port` 那一行要由协调者走「公共改动」提交。夹具按与 App 同一套接线
// （会话 + 稳定代理 + 展示回放共用场次 id）直接挂载引擎，所以记录链路（开窗→前态→选择→回执→结算→落库）
// 与真实 App 完全同源；差的是"大厅列表行内状态"那一层 UI。
//
// 查询参数：
//   `?analysis=0` 关掉分析录制（用于「开关关掉后零写入」与「开/关同一副牌结果一致」两条硬护栏）
//   `?seed=N`     固定牌墙与 AI 随机流（两次运行可复算；不给则用随机牌墙）
//   `?llm=1`      座位 1 用真实 LLM 控制器（fetch 打桩），用来端到端验证 LLM 接缝的接线
import { useLotusGame } from '../../../src/game/variants/lotus/lotusGame'
import { buildRingWall } from '../../../src/game/variants/lotus/lotusWall'
import { seededRandom } from '../../../src/game/variants/lotus/bloodFlow/simulation'
import { createAnalysisSession } from '../../../src/game/replay/analysis/session'
import { createAnalysisStorage } from '../../../src/game/replay/analysis/storage'
import { createLotusLegacyDecisionSink } from '../../../src/game/replay/analysis/lotusLegacyAdapter'
import { LotusAiController } from '../../../src/game/variants/lotus/lotusControllers'
import { LotusLlmController, createLlmStats } from '../../../src/game/llm/llmController'
import { ConditionalReasoningCoordinator } from '../../../src/game/llm/conditionalReasoning'
import type { LlmProviderConfig } from '../../../src/game/llm/config'
import { decodeAnalysisBlock, type AnalysisBlockPart } from '../../../src/game/replay/analysis/codec'
import { buildAnalysisExport } from '../../../src/game/replay/analysis/export'
import { createReplayRecorder } from '../../../src/game/replay/recorder'
// P1（§6）：赛后复现的校验器。它是**浏览器侧**模块（内部起真实 `useLotusGame` 重跑一局），
// 所以只能在夹具页面里调用 —— 这也正是它必须在夹具里跑、而不是在 vitest 里跑的原因（§3.5）。
import { replayLotusLegacyRound } from '../../../src/game/replay/analysis/reproduceLotusLegacy'
import type { AnalysisReproduction } from '../../../src/game/replay/analysis/types'
import type { ReplayFrameSource, ReplayMatch, ReplayRecorderHooks, ReplayRound } from '../../../src/game/replay/types'
import type { RoundResult } from '../../../src/game/core/contracts/gamePort'
import type { AnalysisAreaStatus } from '../../../src/game/replay/analysis/types'

interface ProbeStatus {
  ready: boolean
  error: string | null
  errors: string[]
  analysisEnabled: boolean
  seed: number | null
  matchId: string
  /** 分析区的落库状态（列表行内「分析：完整」就是读它，§9.2）。 */
  storedStatus: AnalysisAreaStatus | 'no-match' | null
  /** 落库记录按 tag 计数（`config/decisionState/decision/settlement/llm/…`）。 */
  partsByTag: Record<string, number>
  decisionsBySource: Record<string, number>
  decisionWindowIds: string[]
  decisionStateIds: string[]
  /** 决策条数（按 `windowId#seat` 去重）——录制器在 chosen 与 receipt 各推一份 decision，去重后才是决策数。 */
  distinctDecisions: number
  /** 没有 windowId 的决策条数（§3.1 要求为 0）。 */
  decisionsWithoutWindowId: number
  /** 同一个 windowId 落在两个座位上的次数（应为 0：一个窗口只属于一个座位）。 */
  windowIdSeatConflicts: number
  /** 有状态缺合法动作、或有决策缺前态的条数（都应为 0）。 */
  decisionsWithoutState: number
  decisionStatesWithoutActions: number
  settlements: Array<{ roundIndex: number; deltas: number[]; sum: number; kind: string; winners: number[] }>
  /** 结算里"四家变化之和不为 0"的条数（§5 判据，应为 0）。 */
  settlementsNotBalanced: number
  /** 展示回放的局数与动作计数（与是否开分析无关的对局侧量，用于开/关一致性）。 */
  replayRounds: number
  gameEvents: { roundStart: number; draw: number; discard: number; tableAction: number; roundEnd: number }
  /** 对局最终分数与局数。 */
  finalScores: number[]
  roundsPlayed: number
  /** 导出包（与界面同一条构建路径）：自包含判据。 */
  exportManifest: {
    recordsTotal: number
    configurations: number
    includesReplay: boolean
    configReferencesClosed: boolean
    replayRounds: number
    missing: string[]
  } | null
  reproductionCapable: boolean | null
  /** 分析区的块数与场次元数据条数（关掉分析时都应为 0 ⇒ 零写入）。 */
  storageBlocks: number
  storageMatches: number
  /** 存储可用性（不可用时上面的 0 不能当作"零写入"的证据）。 */
  storageAvailable: boolean
  /** 本场消耗的 Math.random 抽取次数：开/关两次必须相等，否则比的根本不是同一副牌。 */
  rngDraws: number
  /** LLM 座位（`?llm=1`）：落库的尝试条数、模板条数，以及"模型请求真的发出去过"的证据。 */
  llmParts: number
  promptTemplateParts: number
  /** 落库尝试里 user 变量的样本（用它与发给模型的请求体比对是否逐字相等）。 */
  attemptUserSample: string | null
  /** 打桩模型收到的请求体里那条 user 消息（与上一个字段比对）。 */
  sentUserSample: string | null
  /** 决策来源分布（LLM 座位接通后应出现 model / model-fallback）。 */
  decisionSources: string[]
  /** 有 llm 尝试却**没有**标成模型来源的决策条数（应为 0：有请求就必须归因到模型侧）。 */
  attemptDecisionsWithoutModelSource: number
  /** P1：落库的复现数据条数（关掉分析时必须为 0 ⇒ 零成本）。 */
  reproductionParts: number
  /** P1：逐局重跑的结论（§4「整局重跑到同一结束状态」的机器可判据）。 */
  reproductionRounds: ReproductionRun[]
  /**
   * P1：把 `postDealHands` 改一张之后的重跑结论。
   * 必须 `ok=false`、原因里带「发牌算法变了或记录与引擎不一致」，且 **一条命令都没消费**
   * （`commandsConsumed=0`）—— 这证明校验器是"停下来"，而不是拿另一副牌把这一局跑完了。
   */
  postDealTamper: { ok: boolean; reason: string | null; windowsOpened: number; commandsConsumed: number } | null
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
  gaps: string[]
}

const status: ProbeStatus = {
  ready: false, error: null, errors: [], analysisEnabled: true, seed: null, matchId: '',
  storedStatus: null, partsByTag: {}, decisionsBySource: {}, decisionWindowIds: [], decisionStateIds: [],
  distinctDecisions: 0, decisionsWithoutWindowId: 0, windowIdSeatConflicts: 0,
  decisionsWithoutState: 0, decisionStatesWithoutActions: 0,
  settlements: [], settlementsNotBalanced: 0, replayRounds: 0,
  gameEvents: { roundStart: 0, draw: 0, discard: 0, tableAction: 0, roundEnd: 0 },
  finalScores: [], roundsPlayed: 0, exportManifest: null, reproductionCapable: null,
  storageBlocks: 0, storageMatches: 0, storageAvailable: false, rngDraws: 0,
  llmParts: 0, promptTemplateParts: 0, attemptUserSample: null, sentUserSample: null, decisionSources: [],
  attemptDecisionsWithoutModelSource: 0,
  reproductionParts: 0, reproductionRounds: [], postDealTamper: null,
}
;(window as unknown as { __lotusLegacyProbe: ProbeStatus }).__lotusLegacyProbe = status

// 节奏压缩：所有定时器 0ms（与 analysis-probe / replay 夹具同一套），整场几秒跑完。
const realSetTimeout = window.setTimeout.bind(window)
window.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => (
  realSetTimeout(handler as never, 0, ...args)
)) as typeof window.setTimeout
const tick = (ms = 0) => new Promise<void>((resolve) => { realSetTimeout(() => resolve(), ms) })

/** 夹具侧读分析区：不经过 storage 封装，直接证明"数据真的落进了 IndexedDB"。 */
async function readAnalysisArea(): Promise<{
  blocks: Array<Record<string, unknown>>
  matches: Array<Record<string, unknown>>
  parts: AnalysisBlockPart[]
}> {
  // **绝不能**用 `indexedDB.open(name)` 直接探库：库里不存在时那次调用会把一个**空库**
  // （版本 1、一个对象仓库都没有）建出来，之后真正的驱动再打开就不会触发 onupgradeneeded，
  // 于是所有写入都撞 NotFoundError 并把分析区停用（实测：开/关两次对比的第二次就是这么挂的）。
  // 先用 databases() 判断库里在不在，不在就是"没有记录"。
  const exists = (await indexedDB.databases?.())?.some((entry) => entry.name === 'lianhua-guangma-analysis')
  if (!exists) return { blocks: [], matches: [], parts: [] }
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open('lianhua-guangma-analysis')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
  if (!db) return { blocks: [], matches: [], parts: [] }
  const readAll = <T,>(store: string) => new Promise<T[]>((resolve) => {
    // 一次都没写过时，分析区的对象仓库可能还没建起来（库是在首次写入时升级出来的）——
    // "仓库不存在"就等于"没有任何记录"，不是错误。
    if (!db.objectStoreNames.contains(store)) return resolve([])
    try {
      const tx = db.transaction(store, 'readonly')
      const request = tx.objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result as T[])
      request.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
  const blocks = await readAll<Record<string, unknown>>('blocks')
  const matches = await readAll<Record<string, unknown>>('matches')
  db.close()
  const parts: AnalysisBlockPart[] = []
  for (const block of blocks.slice().sort((a, b) => Number(a.sequence) - Number(b.sequence))) {
    const decoded = await decodeAnalysisBlock({
      sequence: Number(block.sequence),
      codec: String(block.codec) as 'gzip' | 'raw',
      rawBytes: Number(block.rawBytes),
      storedBytes: Number(block.storedBytes),
      checksum: String(block.checksum),
      parts: Number(block.parts),
      payload: new Uint8Array((block.payload as Uint8Array | ArrayBuffer) as ArrayBuffer),
    })
    if (decoded.parts) parts.push(...decoded.parts)
  }
  return { blocks, matches, parts }
}

void (async () => {
  try {
    const params = new URLSearchParams(location.search)
    status.analysisEnabled = params.get('analysis') !== '0'
    // P1：`?replay=0` 跳过逐局重跑（P0 的形状用例与开/关硬护栏不需要它，省一次全套重跑的时间）。
    const replayEnabled = params.get('replay') !== '0'
    const seedParam = Number(params.get('seed'))
    const seed = Number.isFinite(seedParam) && seedParam > 0 ? seedParam : null
    status.seed = seed
    // AI 的弃牌选择走 `Math.random`（`LotusAiController.requestTurn` 调 `decideTurn` 时没透传
// 构造参数里的 `random`，所以那条注入路径实际是死的）。固定牌墙还不够：随机流也要固定，
// 两次运行才可比。**顺序必须完全一致**：牌墙与两颗骰子都由查询参数钉死，
// 所以对局期间除了 AI 的弃牌平局判定之外，只有展示回放录制器取场次 id 会抽一次
// （`createReplayRecorder` 的 `defaultId` 每次都走 Math.random，分析侧的 `defaultId` 则优先
// 用 `crypto.randomUUID`）—— 那次抽取下面**无条件**执行，保证开/关两条路径的抽取次数相同。
    let rngDraws = 0
    if (seed !== null) {
      const stream = seededRandom(seed ^ 0x9e3779b9)
      Math.random = () => { rngDraws += 1; return stream() }
    }

    const storage = createAnalysisStorage({
      // 分析区自身的失败（驱动异常→停用）只在 onError 里露出来；不接的话只会看到录制器
      // 后面那句笼统的"分析区不可用"，查不出真正原因。
      onError: (detail) => status.errors.push(`分析区：${detail}`),
    })
    status.storageAvailable = storage.available()
    const session = createAnalysisSession({
      enabled: status.analysisEnabled,
      storage,
      onError: (detail) => status.errors.push(`分析记录：${detail}`),
    })
    // LLM 记录接缝（`?llm=1` 才装）：与 App 侧同一套 —— 接缝先于控制器构造，
    // 再把 `hooks` 合并进 `createLotusLlmControllers` 的入参。这里只为验证接线，
    // 所以只给座位 1 一个真实 LLM 控制器，其余仍是本地 AI。
    const useLlmSeat = params.get('llm') === '1'
    const sink = useLlmSeat
      ? createLotusLegacyDecisionSink({
        recorder: session.port,
        onError: (detail) => status.errors.push(`分析接缝：${detail}`),
      })
      : null
    /** 打桩模型：回 A1（提示词里的第一个候选编号），并把收到的请求体抓下来。 */
    const sentBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = []
    if (useLlmSeat) {
      const sse = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ choice: 'A1', message: '稳住。' }) }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')
      ;(window as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init?: RequestInit) => {
        sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof sentBodies)[number])
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }) as typeof fetch
    }
    const llmProvider: LlmProviderConfig = {
      providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-e2e-lotus-legacy',
      model: 'deepseek-chat', style: '稳健', timeoutMs: 8_000,
    }
    const aiControllers = useLlmSeat && sink
      ? [
        new LotusLlmController(llmProvider, sink.hooks, createLlmStats(), new ConditionalReasoningCoordinator()),
        new LotusAiController({ turn: 0, afterKong: 0, claim: 0 }),
        new LotusAiController({ turn: 0, afterKong: 0, claim: 0 }),
      ]
      : undefined
    // 展示回放录制器：内存 sink（夹具不测回放库），同时用作"对局侧动作计数"的独立观测点。
    const recorder = createReplayRecorder({
      sink: { saveMatch: () => {}, saveRound: () => {} },
      meta: () => ({
        rulesetId: 'lotus-legacy', rulesetName: '莲花麻将·翻精癞子',
        themeName: 'jade', humanSeat: 0, analysisRecorded: session.active(),
      }),
    })
    const rawHooks = recorder.hooks
    const hooks: ReplayRecorderHooks = {
      roundStart: (frame: ReplayFrameSource) => { status.gameEvents.roundStart += 1; rawHooks.roundStart(frame) },
      draw: (event, frame: ReplayFrameSource) => { status.gameEvents.draw += 1; rawHooks.draw(event, frame) },
      discard: (event, frame: ReplayFrameSource) => { status.gameEvents.discard += 1; rawHooks.discard(event, frame) },
      tableAction: (event, frame: ReplayFrameSource) => { status.gameEvents.tableAction += 1; rawHooks.tableAction(event, frame) },
      roundEnd: (result: RoundResult, frame: ReplayFrameSource) => { status.gameEvents.roundEnd += 1; rawHooks.roundEnd(result, frame) },
    }

    interface HumanDriver {
      hasPendingTurn(): boolean
      hasPendingHu(): boolean
      hasPendingClaim(): boolean
      hasPendingChi(): boolean
      hasPendingRobKong(): boolean
      resolveDiscard(index: number): void
      resolveHu(action: { kind: string }): void
      resolveClaimPass(): void
      resolveChiPass(): void
      resolveRobKongAction(action: 'win' | 'pass'): void
    }
    const game = useLotusGame({
      playSound: () => {}, playSoundAndWait: async () => {},
      countdownEnabled: false,
      recorder: hooks,
      analysis: session.port,
      ...(aiControllers ? { aiControllers } : {}),
      ...(sink ? { analysisSink: sink } : {}),
    }) as unknown as {
      phase: { value: string }
      result: { value: RoundResult | null }
      round: { value: number }
      matchFinished: { value: boolean }
      players: Array<{ score: number; hand: string[] }>
      humanController: HumanDriver
      startGame(mode?: 'east' | 'hanchan', options?: Record<string, unknown>): unknown
      nextRound(options?: Record<string, unknown>): void
    }

    /** 人类座位（0 号）的驱动器：调用的正是 UI 按钮最终调的那几个 resolve（lotusHuman.ts 的同一入口）。 */
    const driveHuman = () => {
      const human = game.humanController
      try {
        // 永远弃最后一张：**必须是合法下标**，否则编排层会兜底成最后一张，
        // 而记录里的选择就对不回任何合法候选（chosen 的 legalActionId 会变成 null）。
        if (human.hasPendingTurn()) human.resolveDiscard(Math.max(0, (game.players[0]?.hand.length ?? 1) - 1))
        else if (human.hasPendingHu()) human.resolveHu({ kind: 'pass' })
        else if (human.hasPendingClaim()) human.resolveClaimPass()
        else if (human.hasPendingChi()) human.resolveChiPass()
        else if (human.hasPendingRobKong()) human.resolveRobKongAction('pass')
      } catch (error) {
        status.errors.push(`人类座位驱动失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 无条件取一次场次 id（它会消耗一次 Math.random，见上面的注释）：开/关两条路径的
    // 随机流抽取次数必须逐位相同，否则比的是两副不同的牌。
    const matchId = recorder.ensureMatchId()
    if (status.analysisEnabled) {
      // 与 App 同口径：分析场次与展示回放**共用同一个场次 id**（§9.2）。
      session.start({
        matchId,
        rulesetId: 'lotus-legacy',
        rules: { id: 'lotus-legacy' },
        rulesVersion: 'lotus-legacy',
        aiConfig: null,
        aiStrategy: 'source-v2',
        // 本机单机：0 号座是人类，其余是本地启发式 AI（LLM 座位本阶段不接钩子，见文档）。
        seatControl: ['human', 'local-ai', 'local-ai', 'local-ai'],
        engineBuild: 'e2e-analysis-lotus-legacy',
      })
    }

    const wall = (extra: number) => (seed === null
      ? {}
      : { initialWall: buildRingWall(seededRandom(seed + extra)), openingDice: [2, 3] as [number, number], openingSecondDice: [1, 4] as [number, number] })
    game.startGame('east', wall(0))

    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      driveHuman()
      if (game.matchFinished.value || game.phase.value === 'finished') break
      if (game.phase.value === 'settled') {
        // 推进整场：真实 UI 上就是结算框的"继续"按钮。打完最后一局时它只置
        // `matchFinished`/`phase='finished'`，不会再开一局（matchLifecycle.nextRound 的行为）。
        game.nextRound(wall(game.round.value))
        await tick()
        continue
      }
      if (game.phase.value === 'lobby') throw new Error('对局回到大厅，未打完')
      await tick()
    }
    if (!game.matchFinished.value && game.phase.value !== 'finished') {
      status.errors.push(`对局未打完：phase=${game.phase.value} round=${game.round.value}`)
    }
    // 打完的局数以"局末结算次数"为准：`state.round` 在最后一局推进后已经指向下一局了。
    status.roundsPlayed = status.gameEvents.roundEnd
    status.finalScores = game.players.map((player) => player.score)
    status.rngDraws = rngDraws
    const replayMatch: ReplayMatch | null = recorder.finishAuto()
    const replayRounds: ReplayRound[] = recorder.snapshot().rounds
    status.replayRounds = replayRounds.length

    if (status.analysisEnabled) {
      const finished = await session.finish()
      status.matchId = finished.matchId
      status.storedStatus = finished.status
    }

    // ── 从分析区读回（不是从内存里的端口）──
    const area = await readAnalysisArea()
    status.storageBlocks = area.blocks.length
    status.storageMatches = area.matches.length
    for (const part of area.parts) status.partsByTag[part.tag] = (status.partsByTag[part.tag] ?? 0) + 1
    const meta = status.matchId
      ? area.matches.find((entry) => entry.matchId === status.matchId)
      : undefined
    if (meta) status.storedStatus = String(meta.status) as AnalysisAreaStatus
    else if (status.analysisEnabled) status.storedStatus = 'no-match'

    const decisions = area.parts.filter((part) => part.tag === 'decision').map((part) => part.value as Record<string, unknown>)
    const states = area.parts.filter((part) => part.tag === 'decisionState').map((part) => part.value as Record<string, unknown>)
    // 每个决策会落**两条** `decision` 记录（chosen 一条、receipt 一条，内容不同、windowId 相同），
    // 所以这里按 `windowId#seat` 去重才是决策数 —— 直接数记录条数会数成两倍。
    const decisionKeys = new Set<string>()
    const windowToSeat = new Map<string, number>()
    for (const decision of decisions) {
      const windowId = String(decision.windowId ?? '')
      const seat = Number(decision.seat ?? -1)
      const source = String(decision.source ?? 'unknown')
      status.decisionsBySource[source] = (status.decisionsBySource[source] ?? 0) + 1
      if (!windowId) { status.decisionsWithoutWindowId += 1; continue }
      decisionKeys.add(`${windowId}#${seat}`)
      const previous = windowToSeat.get(windowId)
      if (previous !== undefined && previous !== seat) status.windowIdSeatConflicts += 1
      windowToSeat.set(windowId, seat)
    }
    status.distinctDecisions = decisionKeys.size
    for (const windowId of windowToSeat.keys()) status.decisionWindowIds.push(windowId)
    for (const state of states) {
      status.decisionStateIds.push(String(state.id ?? ''))
      const actions = state.legalActions
      if (!Array.isArray(actions) || actions.length === 0) status.decisionStatesWithoutActions += 1
    }
    const stateIds = new Set(status.decisionStateIds)
    // 决策上的 `stateId` 就是前态记录的 id（`${windowId}/${seat}`）：两边必须逐条对得上。
    status.decisionsWithoutState = decisions
      .filter((decision) => !stateIds.has(String(decision.stateId ?? ''))).length

    for (const part of area.parts.filter((entry) => entry.tag === 'settlement')) {
      const record = part.value as { roundIndex?: number; deltas?: number[]; kind?: string; winners?: number[] }
      const deltas = record.deltas ?? []
      const sum = deltas.reduce((total, delta) => total + delta, 0)
      if (sum !== 0) status.settlementsNotBalanced += 1
      status.settlements.push({
        roundIndex: record.roundIndex ?? 0, deltas, sum,
        kind: String(record.kind ?? ''), winners: record.winners ?? [],
      })
    }

    // ── 导出包：与界面同一条构建路径（自包含 = 记录 + 被引用配置 + 展示回放）──
    if (status.analysisEnabled && replayMatch) {
      const configurations = status.matchId ? await storage.readConfigs(status.matchId) : []
      const exported = buildAnalysisExport({
        match: replayMatch,
        rounds: replayRounds,
        parts: area.parts,
        configurations,
        status: (status.storedStatus ?? 'missing') as AnalysisAreaStatus,
      })
      status.exportManifest = {
        recordsTotal: exported.manifest.recordsTotal,
        configurations: exported.manifest.configurations,
        includesReplay: exported.manifest.includesReplay,
        configReferencesClosed: exported.manifest.configReferencesClosed,
        replayRounds: exported.manifest.replayRounds,
        missing: [...exported.manifest.missing],
      }
      status.reproductionCapable = exported.reproductionCapable
    }

    // ── P1（§6）：从分析区读回复现数据 → 在夹具里**逐局重跑**，看是否到达同一结束状态 ──
    //
    // 关键点：重跑用的是**落库读回**的那份记录（不是内存里的对象），因此它同时验证了
    // 编码/解码/落库/读回这一整条链路没有把复现数据弄丢或改形。
    if (status.analysisEnabled && replayEnabled) {
      const reproductionParts = area.parts.filter((part) => part.tag === 'reproduction')
      status.reproductionParts = reproductionParts.length
      // 结束分数用**结算记录**里的 `scoresAfter`（每局一条）—— 那是"记录侧权威的结束状态"。
      const scoresByRound = new Map<number, number[]>()
      for (const part of area.parts.filter((entry) => entry.tag === 'settlement')) {
        const record = part.value as { roundIndex?: number; scoresAfter?: number[] }
        if (typeof record.roundIndex === 'number' && Array.isArray(record.scoresAfter)) {
          scoresByRound.set(record.roundIndex, record.scoresAfter)
        }
      }
      const records = reproductionParts
        .map((part) => part.value as AnalysisReproduction)
        .sort((a, b) => a.roundIndex - b.roundIndex)
      for (const record of records) {
        const run = await replayLotusLegacyRound({
          reproduction: record,
          commands: (record.commands ?? []).filter((entry) => (entry.resolution ?? 'command') === 'command'),
          expectedScores: scoresByRound.get(record.roundIndex) ?? null,
          tick,
        })
        status.reproductionRounds.push({
          roundIndex: run.roundIndex, ok: run.ok, reason: run.reason,
          scoresMatch: run.scoresMatch, expectedScores: run.expectedScores, finalScores: run.finalScores,
          kindMismatches: run.kindMismatches,
          postDealChecked: run.postDealCheck.checked, postDealOk: run.postDealCheck.ok,
          openingChecked: run.openingCheck.checked, openingOk: run.openingCheck.ok,
          windowsOpened: run.metrics.windowsOpened, commandsRecorded: run.metrics.commandsRecorded,
          commandsConsumed: run.metrics.commandsConsumed,
          commandsNotLegalAtRecordTime: run.metrics.commandsNotLegalAtRecordTime,
          withoutWindowId: run.metrics.withoutWindowId, unusedCommands: run.metrics.unusedCommands,
          gaps: run.gaps,
        })
      }
      // 交叉校验的**负向**证据（§3.3）：把第 1 局的 postDealHands 动一张（把首张挪到末尾：
      // **牌的多重集合没变、只有顺序变了**），校验器必须报"不一致"并且**一条命令都不喂**。
      // 用"顺序变了"而不是"换一张牌"是刻意的：它同时证明这道闸不是按集合比的。
      const first = records[0]
      if (first?.postDealHands?.[0] && first.postDealHands[0].length > 1) {
        const tampered: AnalysisReproduction = {
          ...first,
          postDealHands: first.postDealHands.map((hand, seat) => (
            seat === 0 ? [...hand.slice(0, -1), hand[0]] : [...hand]
          )),
        }
        const run = await replayLotusLegacyRound({
          reproduction: tampered, commands: first.commands ?? [], expectedScores: null, tick,
        })
        status.postDealTamper = {
          ok: run.ok, reason: run.reason,
          windowsOpened: run.metrics.windowsOpened, commandsConsumed: run.metrics.commandsConsumed,
        }
      }
    }

    // ── LLM 接缝（`?llm=1`）：落库的尝试、模板去重，以及"落库的 user == 发给模型的 user" ──
    status.decisionSources = [...new Set(decisions.map((decision) => String(decision.source ?? 'unknown')))].sort()
    // 有请求的决策必须归因到模型侧。**反过来不成立**：LLM 座位在"必成杠上开花/已成和/无选项"
    // 这些分支上会短路成本地逻辑、根本不发请求（见文档 §6 的表），那些窗口没有 llm 记录、
    // 来源也不会是 model —— 此时 `unknown` 是如实的（确实没有模型参与），不是漏记。
    status.attemptDecisionsWithoutModelSource = decisions.filter((decision) => {
      const ids = decision.llmAttemptIds
      if (!Array.isArray(ids) || ids.length === 0) return false
      const source = String(decision.source ?? 'unknown')
      return source !== 'model' && source !== 'model-fallback'
    }).length
    const attempts = area.parts.filter((part) => part.tag === 'llm').map((part) => part.value as {
      promptVariables?: { user?: string }
    })
    status.llmParts = attempts.length
    status.promptTemplateParts = area.parts.filter((part) => part.tag === 'promptTemplate').length
    status.attemptUserSample = attempts.find((attempt) => attempt.promptVariables?.user)?.promptVariables?.user ?? null
    status.sentUserSample = sentBodies
      .map((body) => body.messages?.find((message) => message.role === 'user')?.content ?? null)
      .find((content) => content !== null) ?? null

    status.ready = true
  } catch (error) {
    status.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  }
})()