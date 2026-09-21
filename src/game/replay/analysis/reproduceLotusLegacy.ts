// 翻精癞子 P1（§6）：把赛后复现数据（**环状牌墙 136 张 + 两颗骰子 + 权威动作日志**）
// 在真实引擎里重跑一遍，看是否到达同一个结束状态。
//
// 为什么必须在**浏览器**里跑：`useLotusGame` 是 Vue composable（watch／定时器／音效全在 Vue 里），
// 不是纯函数。在 Node 里另搭一套演出与定时器，得到的东西与线上不是同一个（方案 §3.5），
// 因此本模块由夹具页面（`tests/e2e/fixtures/analysis-lotus-legacy.ts`）调用：
// 它自己**不碰分析区、不落任何记录** —— 装进去的录制器只是观测桩（拿重跑自己的窗口与合法动作）。
//
// 五条不许含糊的原则（与血流 `replayReproduction.ts` 同口径）：
// 1. **交叉校验**：先用 `ringWall + dice + dealer` 重新发牌，与记录里的 `postDealHands`
//    与翻精读数比对。不一致就直接报「发牌算法变了或记录与引擎不一致」并**停止** —— 否则
//    只是拿另一副牌跑了一遍，却会得出"复现成功/失败"的错误结论（§3.3）。
// 2. 命令与**重跑此刻**的合法动作对不上 ⇒ 报"对不上"，绝不跳过这条命令继续跑。
// 3. 命令用尽而牌局未结束 ⇒ 报"记录不足"；牌局结束了却还有没消费的命令 ⇒ 报"记录多出条目"。
// 4. 记录缺 `openingScores` ⇒ 结束分数**无从比对**，如实报"不可比对"，不拿跑出来的数字去比。
// 5. 顺序判据一律用 `windowId`（末段的自增编号），**不依赖数组顺序** —— 异步回传会让
//    数组顺序 ≠ 执行顺序（这正是 P0 给每个窗口编稳定 ID 的原因）。
import type { MatchType, TileType } from '../../core/contracts/types'
import type { ChiMeld } from '../../variants/lotus/lotusRules'
import { useLotusGame } from '../../variants/lotus/lotusGame'
import type {
  LotusChiContext, LotusClaimContext, LotusController, LotusHuContext, LotusRobKongContext, LotusTurnContext,
} from '../../variants/lotus/lotusControllers'
import type { AnalysisCommandEntry } from './commandEntry'
import {
  commandEntryMatchKey, compareLotusOpeningExtras, comparePostDealHands,
  type LotusCrossCheck,
} from './lotusReproduction'
import { tileFromName } from './openingFromReproduction'
import { reproductionDeficiencies } from './reproductionCapability'
import type {
  AnalysisAttemptFinishInput, AnalysisAttemptStartInput, AnalysisCandidatesInput, AnalysisChoiceInput,
  AnalysisMatchInput, AnalysisReceiptInput, AnalysisRecorder, AnalysisWindowInput,
} from './recorder'
import type { AnalysisLegalAction, AnalysisReproduction, AnalysisSettlement, AnalysisWindowKind } from './types'

export interface LotusReplayInput {
  reproduction: AnalysisReproduction
  commands: readonly AnalysisCommandEntry[]
  /** 记录侧的结束分数（`settlement.scoresAfter`）。没给就是"只验证能跑完"，不谎称结果一致。 */
  expectedScores?: readonly number[] | null
  /** 单次让出事件循环；夹具把定时器压到 0ms，所以默认 0 就够（真实页面按真实节奏跑）。 */
  tick?: () => Promise<void>
  /** 硬时限与推进上限：畸形数据不得把校验挂住。 */
  deadlineMs?: number
  maxTicks?: number
}

export interface LotusReplayResult {
  ok: boolean
  reason: string | null
  roundIndex: number
  finalScores: number[]
  expectedScores: number[] | null
  /** null = 没有可比对的期望分数（只验证"能跑完"）。 */
  scoresMatch: boolean | null
  /** 记录侧与重跑侧的窗口序列不一致的次数（kind 或座位对不上）。 */
  kindMismatches: number
  /** 发牌结果的交叉校验（§3.3 的那道闸）。 */
  postDealCheck: LotusCrossCheck
  /** 由牌墙 + 骰子推出的开局读数（翻精/精牌/开牌断点）的交叉校验。 */
  openingCheck: LotusCrossCheck
  metrics: {
    /** 重跑实际开出的决策窗口数。 */
    windowsOpened: number
    /** 记录里的命令条目数（只算 `command` 口径）。 */
    commandsRecorded: number
    /** 被消费的记录条目数。 */
    commandsConsumed: number
    /** 缺 `windowId` 的条目数（顺序判据失效 ⇒ 记录缺陷）。 */
    withoutWindowId: number
    /** 记录里存在、但重跑从未走到对应窗口的条目数。 */
    unusedCommands: number
    /** 重跑开出、记录里没有对应条目的窗口数。 */
    extraWindows: number
    /**
     * 记录里**不是命令口径**的条目数（`expire` 靠超时推进 / `auto` 自动推进）。
     *
     * 这两个口径是**血流权威端**的概念（`expireEntry`、`useBloodFlowGame` 的 `resolution:'auto'`）；
     * 翻精癞子没有靠超时推进的窗口，因此本校验器**不重放**它们，但**也绝不静默丢掉** ——
     * 计入这里并在有任何一条时直接判不通过（"不许跳过命令"）。
     */
    nonCommandEntries: number
    /**
     * 被**照原样重放**、但记录侧自己标了"当时不在合法动作里"的条目数
     * （P0 的 `chosenIndex = -1`：条目没有 `legalActionId`）。这类条目仍然逐条执行，
     * 只是不做"必须命中合法动作"的断言 —— 记录自己说了它当时就不合法。
     */
    commandsNotLegalAtRecordTime: number
  }
  /** 重跑侧窗口轨迹（诊断：一眼看出在哪一步与记录错开）。 */
  windowTrace: string[]
  /** 观测桩收到的留痕（重跑不落库，只用来解释失败）。 */
  gaps: string[]
}

/** 重跑侧观测到的窗口（由观测桩在 `windowOpened` 时登记）。 */
interface ReplayWindow {
  no: number
  windowId: string
  seat: number
  kind: AnalysisWindowKind
  legalActions: AnalysisLegalAction[]
}

const DEFAULT_MAX_TICKS = 200_000
const DEFAULT_DEADLINE_MS = 120_000

/** 窗口 ID 末段的自增编号（两侧各自从 1 开始；顺序判据就是它，不是数组下标）。 */
function windowNumberOf(windowId: string | undefined): number {
  if (!windowId) return Number.NaN
  return Number(windowId.split('/').pop())
}

/**
 * 只有翻精癞子的记录能被这个校验器处理：两个玩法的重跑起点不同（环状牌墙 vs 发牌后牌墙），
 * 拿血流记录硬套会重跑出另一副牌。认不出来就如实报"不适用"，不猜。
 */
function variantMismatchReason(record: AnalysisReproduction): string | null {
  const looksLotus = record.variant === 'lotus-legacy' || Array.isArray(record.ringWall)
  if (looksLotus) return null
  return `这份复现数据不是翻精癞子的口径（variant=${record.variant ?? '（未标）'}、ringWall=${record.ringWall ? '有' : '无'}）：本校验器只认环状牌墙口径，不硬套血流的判据`
}

export async function replayLotusLegacyRound(input: LotusReplayInput): Promise<LotusReplayResult> {
  const reproduction = input.reproduction
  const expected = input.expectedScores && input.expectedScores.length === 4 ? [...input.expectedScores] : null
  const maxTicks = input.maxTicks ?? DEFAULT_MAX_TICKS
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS
  const tick = input.tick ?? (() => new Promise<void>((resolve) => { setTimeout(resolve, 0) }))

  // ── 记录侧：按 windowId 编成"窗口编号 → 命令条目"（顺序判据；不依赖数组顺序）──
  const recordedByNo = new Map<number, AnalysisCommandEntry>()
  const notLegalAtRecordTime = new Set<number>()
  const nonCommandResolutions = new Set<string>()
  let nonCommandEntries = 0
  let withoutWindowId = 0
  for (const entry of input.commands) {
    if (entry.resolution !== undefined && entry.resolution !== 'command') {
      // `expire`/`auto` 是血流权威端的推进口径，本玩法没有这类窗口 ⇒ 不重放、也不静默丢。
      nonCommandEntries += 1
      nonCommandResolutions.add(String(entry.resolution))
      continue
    }
    const no = windowNumberOf(entry.windowId)
    if (!Number.isFinite(no)) { withoutWindowId += 1; continue }
    recordedByNo.set(no, entry)
    // 条目带 `legalActionId` ⇔ 当时它确实落在该窗口的合法动作里（P0 的 chosenIndex ≥ 0）。
    if (!entry.legalActionId) notLegalAtRecordTime.add(no)
  }

  const windows: ReplayWindow[] = []
  const consumed = new Set<number>()
  const windowTrace: string[] = []
  const gaps: string[] = []
  let kindMismatches = 0
  let extraWindows = 0
  let commandsConsumed = 0
  let pending: ReplayWindow | null = null
  let openingChecked = false
  let failed: string | null = null
  let postDealCheck: LotusCrossCheck = { checked: false, ok: false, reason: null }
  let openingCheck: LotusCrossCheck = { checked: false, ok: false, reason: null }
  let game: LotusReplayPort | null = null

  function stop(reason: string) {
    if (!failed) failed = reason
  }

  function metrics() {
    return {
      windowsOpened: windows.length,
      commandsRecorded: recordedByNo.size,
      commandsConsumed,
      withoutWindowId,
      unusedCommands: [...recordedByNo.keys()].filter((no) => !consumed.has(no)).length,
      extraWindows,
      nonCommandEntries,
      commandsNotLegalAtRecordTime: notLegalAtRecordTime.size,
    }
  }

  function result(ok: boolean, reason: string | null, finalScores: number[], scoresMatch: boolean | null): LotusReplayResult {
    return {
      ok, reason,
      roundIndex: reproduction.roundIndex,
      finalScores, expectedScores: expected, scoresMatch,
      kindMismatches, postDealCheck, openingCheck,
      metrics: metrics(), windowTrace: [...windowTrace], gaps: [...gaps],
    }
  }

  // ── 前置判定：缺字段 ⇒ 根本不重跑（缺什么就报什么，绝不补默认值）──
  const variantReason = variantMismatchReason(reproduction)
  if (variantReason) return result(false, variantReason, [], null)
  // 缺开局分数 ⇒ 重跑只能从初始分起步，结束分数与记录**不可比对**。这时必须如实说"不可比对"，
  // 不能拿跑出来的数字去比（第 2 局以后必然不一致，会被误读成"牌流复现失败"）。
  // 这条**刻意排在**通用缺字段清单之前：缺的正是它时，要说清"为什么这次一个数字都不能比"，
  // 而不是笼统地列一句"缺 openingScores"。
  if (expected && (!reproduction.openingScores || reproduction.openingScores.length !== 4)) {
    return result(false, '复现数据缺少 openingScores（当局开局分数）：重跑只能从初始分起步，结束分数不可比对（不宣称精确复现）', [], null)
  }
  const deficiencies = reproductionDeficiencies(reproduction)
  if (deficiencies.length) {
    return result(false, `复现数据不完整，缺少：${deficiencies.join('、')}`, [], null)
  }
  if (nonCommandEntries) {
    // 口径不对 ⇒ 连跑都不跑，如实说清"这些条目是什么、为什么不能重放"。
    // §4 的"被拒动作不出现"：这类条目一旦出现，说明记录不是本玩法的权威口径，绝不能靠过滤掉它来"跑绿"。
    return result(false, `记录里有 ${nonCommandEntries} 条不是命令口径的条目（${[...nonCommandResolutions].join('、')}）：`
      + `翻精癞子没有靠超时/自动推进的窗口，本校验器无法重放它们，也不静默跳过 —— 不宣称精确复现`, [], null)
  }

  // ── 观测桩：只为拿到"重跑自己的窗口与合法动作"（与 P0 记录同一套投影），不落任何记录 ──
  const recorderStub: AnalysisRecorder = {
    enabled: true,
    paused: () => false,
    beginMatch: (_input: AnalysisMatchInput) => 'lotus-replay',
    windowOpened: (window: AnalysisWindowInput) => {
      // 这个桩**绝不能抛**：引擎的 `windowOpened` 包在 `safely('window-open')` 里，抛出去会被吞掉，
      // 但"窗口计数器自增"那一步在它后面 —— 桩一抛，编号就不再自增，重跑侧会开出两个都叫 `#1` 的窗口，
      // 后续全被误判成"窗口序列错位"（实测踩过：读了一个端口上不存在的字段）。所以这里自己兜住，
      // 把"观测失败"如实变成一个停止原因。
      try {
        observeWindow(window)
      } catch (error) {
        stop(`重跑侧的观测桩自身出错（不是对局问题，但不能继续）：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    candidates: (_input: AnalysisCandidatesInput) => {},
    promptTemplate: () => {},
    chosen: (_input: AnalysisChoiceInput) => {},
    source: () => {},
    receipt: (_input: AnalysisReceiptInput) => {},
    attemptStarted: (_input: AnalysisAttemptStartInput) => '',
    attemptFinished: (_id: string, _input: AnalysisAttemptFinishInput) => {},
    settlement: (_input: Omit<AnalysisSettlement, 'id'> & { id?: string }) => {},
    reproduction: (_input: AnalysisReproduction) => {},
    noteGap: (gap: { scope: string; from?: number; to?: number; reason: string }) => { gaps.push(`${gap.scope}:${gap.reason}`) },
    flush: async () => {},
    finish: async () => ({ status: 'partial' as const, bytes: 0 }),
    diagnostics: () => ({ decisions: 0, attempts: 0, pendingParts: 0, pendingBytes: 0, paused: false }),
  }

  /** 观测到一个重跑窗口：登记它、做交叉校验、并与记录里的同号命令对齐（§3.3、§3.4）。 */
  function observeWindow(window: AnalysisWindowInput) {
      const no = windowNumberOf(window.windowId)
      const entry: ReplayWindow = {
        no, windowId: window.windowId, seat: window.seat, kind: window.windowKind,
        legalActions: [...window.state.legalActions],
      }
      if (pending) {
        // 编排层是串行的（await 完一个座位的控制器、把动作应用掉，才去问下一个座位）⇒
        // 同时有两个在飞窗口说明前提不成立，如实报出来而不是继续跑。
        stop(`重跑同时开了两个决策窗口（${pending.windowId} 与 ${entry.windowId}）：编排层应当串行`)
      }
      pending = entry
      windows.push(entry)
      if (windowTrace.length < 400) windowTrace.push(`${entry.kind}@${entry.seat}#${Number.isFinite(no) ? no : '?'}`)

      // 交叉校验（§3.3）：第一个窗口 = 庄家起手 = **发牌完成、还没到任何动作**那一刻。
      if (!openingChecked) {
        openingChecked = true
        const port = game
        if (!port) {
          stop('重跑侧读不到牌桌状态（内部错误）：无法交叉校验发牌，因此不宣称复现成功')
          return
        }
        postDealCheck = comparePostDealHands(reproduction.postDealHands, port.players.map((player) => [...player.hand]))
        openingCheck = compareLotusOpeningExtras(reproduction, {
          flipTile: port.flipTile.value, jokers: [...port.jokerTiles.value],
          flipStack: port.flipStack.value, flipSeat: port.flipSeat.value, wallBreakIndex: port.wallBreakIndex.value,
        })
        // 不一致就**停**：继续跑只会拿另一副牌得出错误的"复现成功/失败"结论。
        if (!postDealCheck.ok) stop(`重跑拒绝继续：${postDealCheck.reason}`)
        else if (!openingCheck.ok) stop(`重跑拒绝继续：${openingCheck.reason}`)
      }

      const recorded = recordedByNo.get(no)
      if (!recorded) {
        extraWindows += 1
        stop(`记录不足：重跑开出了第 ${Number.isFinite(no) ? no : '?'} 个决策窗口（${entry.kind}@${entry.seat}），`
          + `但记录里只有 ${recordedByNo.size} 条命令 —— 记录与实际对不上，不跳过、也不假装成功`)
        return
      }
      consumed.add(no)
      if (recorded.seat !== entry.seat) {
        kindMismatches += 1
        stop(`窗口序列错位：第 ${no} 个窗口的座位对不上（记录 seat=${recorded.seat} vs 重跑 seat=${entry.seat}）`)
      }
      if (recorded.windowKind && recorded.windowKind !== entry.kind) {
        kindMismatches += 1
        stop(`窗口序列错位：第 ${no} 个窗口的类型对不上（记录 ${recorded.windowKind} vs 重跑 ${entry.kind}）`)
      }
  }

  // ── 取当前窗口的命令条目：编排层串行 ⇒ `pending` 就是"这次询问"对应的那个窗口 ──
  function takeEntry(method: string, seat: number): { entry: AnalysisCommandEntry; window: ReplayWindow } | null {
    const window = pending
    pending = null
    if (failed) return null
    if (!window) {
      stop(`重跑的 ${method}（seat=${seat}）没有对应的决策窗口：记录与引擎不一致`)
      return null
    }
    if (window.seat !== seat) {
      stop(`重跑的 ${method}（seat=${seat}）拿到的窗口属于 seat=${window.seat}：记录与引擎不一致`)
      return null
    }
    const recorded = recordedByNo.get(window.no)
    if (!recorded) {
      stop(`记录不足：重跑的 ${method}（seat=${seat}）落在第 ${window.no} 个窗口上，但记录里没有该窗口的命令`)
      return null
    }
    // 记录的动作必须落在**重跑此刻**的合法动作里（与 P0 的 chosenIndex 同一条判据）。
    // 唯一的例外是记录侧自己标了"当时就不在合法动作里"的条目（没有 legalActionId）：
    // 对它不做命中断言，但**照样执行**（同样的输入 → 引擎同样的兜底分支）。
    const key = commandEntryMatchKey(recorded)
    if (!window.legalActions.some((action) => legalActionKey(action) === key) && recorded.legalActionId) {
      stop(`第 ${window.no} 个窗口（${window.kind}@${seat}）的命令与当时的合法动作对不上：`
        + `记录 kind=${recorded.kind}${recorded.tile ? ` tile=${recorded.tile}` : ''}`
        + `${recorded.handIndex !== undefined ? ` handIndex=${recorded.handIndex}` : ''}`
        + `${recorded.meldIndex !== undefined ? ` meldIndex=${recorded.meldIndex}` : ''}`
        + `${recorded.tiles?.length ? ` tiles=[${recorded.tiles.join(' ')}]` : ''}（键 ${key}）；`
        + `重跑此刻的合法动作键=[${window.legalActions.map(legalActionKey).join(' / ')}]；`
        + `条目=${JSON.stringify(recorded)}`)
      return null
    }
    commandsConsumed += 1
    return { entry: recorded, window }
  }

  /** 合法动作 → 区分键：与命令条目同一个键函数（组合在合法动作里叫 `meld`、在条目里叫 `tiles`）。 */
  function legalActionKey(action: AnalysisLegalAction): string {
    return commandEntryMatchKey({
      kind: action.kind,
      ...(action.tile !== undefined ? { tile: action.tile } : {}),
      ...(action.handIndex !== undefined ? { handIndex: action.handIndex } : {}),
      ...(action.meldIndex !== undefined ? { meldIndex: action.meldIndex } : {}),
      ...(action.meld?.length ? { tiles: action.meld } : {}),
    })
  }

  /** 记录里的吃组合 → 引擎的 `ChiMeld`：**从 ctx 自己的候选里取那一份**（连 kind 一起，不自己拼）。 */
  function chiMeldOf(ctx: { chiOptions: ChiMeld[] }, tiles: readonly string[] | undefined, window: ReplayWindow): ChiMeld | null {
    const want = [...(tiles ?? [])].sort().join(',')
    const found = ctx.chiOptions.find((option) => [...option.tiles].sort().join(',') === want)
    if (!found) {
      stop(`第 ${window.no} 个窗口的吃组合不在当时的吃候选里（记录 [${(tiles ?? []).join(' ')}]；`
        + `候选=${ctx.chiOptions.map((option) => `[${option.tiles.join(' ')}]`).join(' ')}）：命令与当时的合法动作对不上`)
      return null
    }
    return found
  }

  function scriptedController(seat: number): LotusController {
    /** 取条目并同时拿到它属于哪个窗口号（诊断信息要用）。 */
    const take = (method: string) => takeEntry(method, seat)
    return {
      async requestTurn(ctx: LotusTurnContext) {
        const taken = take('requestTurn')
        if (!taken) return { kind: 'discard', handIndex: Math.max(0, ctx.hand.length - 1) }
        const { entry } = taken
        switch (entry.kind) {
          case 'discard': return { kind: 'discard', handIndex: entry.handIndex ?? Math.max(0, ctx.hand.length - 1) }
          case 'added-kong': return { kind: 'added-kong', meldIndex: entry.meldIndex ?? -1 }
          case 'concealed-kong': return { kind: 'concealed-kong', tile: entry.tile as TileType }
          case 'wind-kong': return { kind: 'wind-kong' }
          case 'win': return { kind: 'win' }
          default: {
            stop(`第 ${taken.window} 个窗口的记录 kind=${entry.kind} 不是摸牌回合的动作：命令与当时的窗口对不上`)
            return { kind: 'discard', handIndex: Math.max(0, ctx.hand.length - 1) }
          }
        }
      },
      async requestDiscardHu(ctx: LotusHuContext) {
        const taken = take('requestDiscardHu')
        if (!taken) return { kind: 'pass' }
        const { entry, window } = taken
        switch (entry.kind) {
          case 'win': return { kind: 'win' }
          case 'pass': return { kind: 'pass' }
          case 'peng': return { kind: 'peng' }
          case 'gang': return { kind: 'gang' }
          case 'chi': {
            const meld = chiMeldOf(ctx, entry.tiles, window)
            return meld ? { kind: 'chi', meld } : { kind: 'pass' }
          }
          default: {
            stop(`第 ${window} 个窗口的记录 kind=${entry.kind} 不是点炮胡窗口的动作：命令与当时的窗口对不上`)
            return { kind: 'pass' }
          }
        }
      },
      async requestClaim(ctx: LotusClaimContext) {
        const taken = take('requestClaim')
        if (!taken) return { kind: 'pass' }
        const { entry, window } = taken
        switch (entry.kind) {
          case 'pass': return { kind: 'pass' }
          case 'gang': return { kind: 'gang' }
          // 碰带的 `discardIndex` 必须原样送回：编排层靠它决定"碰完立刻弃哪张"（不另开窗口）。
          case 'peng':
            return typeof entry.discardIndex === 'number'
              ? { kind: 'peng', discardIndex: entry.discardIndex }
              : { kind: 'peng' }
          case 'chi': {
            const meld = chiMeldOf(ctx, entry.tiles, window)
            return meld ? { kind: 'chi', meld } : { kind: 'pass' }
          }
          default: {
            stop(`第 ${window} 个窗口的记录 kind=${entry.kind} 不是鸣牌窗口的动作：命令与当时的窗口对不上`)
            return { kind: 'pass' }
          }
        }
      },
      async requestChi(ctx: LotusChiContext) {
        const taken = take('requestChi')
        if (!taken) return { kind: 'pass' }
        const { entry, window } = taken
        if (entry.kind === 'pass') return { kind: 'pass' }
        if (entry.kind !== 'chi') {
          stop(`第 ${window} 个窗口的记录 kind=${entry.kind} 不是吃窗口的动作：命令与当时的窗口对不上`)
          return { kind: 'pass' }
        }
        const meld = chiMeldOf(ctx, entry.tiles, window)
        return meld ? { kind: 'chi', meld } : { kind: 'pass' }
      },
      async requestRobKong(_ctx: LotusRobKongContext) {
        const taken = take('requestRobKong')
        if (!taken) return 'pass'
        const { entry, window } = taken
        if (entry.kind === 'win' || entry.kind === 'pass') return entry.kind
        stop(`第 ${window} 个窗口的记录 kind=${entry.kind} 不是抢杠窗口的动作：命令与当时的窗口对不上`)
        return 'pass'
      },
      onDiscarded: () => {},
      reset: () => {},
    }
  }

  // ── 起一个只重跑、不做表现的实例 ──
  const port = useLotusGame({
    playSound: () => {}, playSoundAndWait: async () => {},
    // 倒计时关掉：重跑不该有"超时兜底"这条随机路径（本玩法本来也没有）。
    countdownEnabled: false,
    controllers: [0, 1, 2, 3].map((seat) => scriptedController(seat)),
    // 观测桩（不是真录制器）：只为拿到重跑自己的窗口与合法动作，一个字节都不落库。
    analysis: recorderStub,
  }) as unknown as LotusReplayPort
  game = port

  let startError: string | null = null
  void Promise.resolve(port.startGame('east' as MatchType, {
    initialWall: reproduction.ringWall!.map(tileFromName),
    openingDice: [...reproduction.dice!.first!] as [number, number],
    openingSecondDice: [...reproduction.dice!.second!] as [number, number],
    // 当局庄家与开局分也是重跑输入：少了庄家，翻精方位与发牌顺序都会变；
    // 少了开局分，第 2 局以后的结束分数永远对不上（§6）。
    dealer: reproduction.dealer,
    scores: [...reproduction.openingScores!],
  })).catch((error) => { startError = error instanceof Error ? error.message : String(error) })

  // ── 让引擎跑到局末（`state.result` 落定的那一刻，分数已经算完 —— 见 settlementTimeline）──
  const deadline = Date.now() + deadlineMs
  let ticks = 0
  while (!failed && !port.result.value && !startError && ticks < maxTicks && Date.now() < deadline) {
    ticks += 1
    await tick()
  }

  // 失败/结束后立刻清定时器：0ms 的引擎链会一直自己往下跑，留着只会白烧 CPU 并污染后续观测。
  if (failed || startError) {
    try { port.returnToLobby() } catch { /* 清理失败也要把结论报出去 */ }
  }

  const finalScores = port.players.map((player) => player.score)
  if (startError) return result(false, `重跑开局失败：${startError}`, finalScores, null)
  if (failed) return result(false, failed, finalScores, null)
  if (!port.result.value) {
    return result(false, `重跑未在时限内结束（tick=${ticks}、剩余牌墙 ${port.wall.value.length}、phase=${port.phase.value}）：`
      + `不宣称复现成功`, finalScores, null)
  }
  // 提前终局：牌局结束了却还有没被消费的命令条目 ⇒ 与记录不一致，不能算复现成功。
  const unused = [...recordedByNo.keys()].filter((no) => !consumed.has(no))
  if (unused.length) {
    return result(false, `重跑提前结束：只消费了 ${consumed.size}/${recordedByNo.size} 条命令，`
      + `记录里第 ${unused.join('、')} 个窗口在重跑里没有对应窗口`, finalScores, null)
  }
  if (withoutWindowId) {
    return result(false, `记录里有 ${withoutWindowId} 条命令缺 windowId：顺序判据（windowId）不成立，无法宣称精确复现`, finalScores, null)
  }
  if (!expected) {
    // 没有"记录侧的结束分数"就没有可比的终态：重跑跑完了也不能算复现成功（§2.3：不许拿跑通当复现）。
    return result(false, '记录里没有这一局的结束分数（结算记录缺失）⇒ 无法比对结束状态，不宣称复现成功', finalScores, null)
  }
  const scoresMatch = expected.every((score, seat) => score === finalScores[seat])
  return result(
    scoresMatch,
    scoresMatch ? null : `结束分数不一致：记录 ${expected.join('/')} ≠ 重跑 ${finalScores.join('/')}`,
    finalScores, scoresMatch,
  )
}

/** 重跑只用到的那部分渲染无关状态（`useLotusGame` 的端口是只读引用集合）。 */
interface LotusReplayPort {
  players: Array<{ hand: string[]; score: number }>
  result: { value: { draw?: boolean; winnerIndex?: number } | null }
  phase: { value: string }
  wall: { value: string[] }
  flipTile: { value: string | null }
  jokerTiles: { value: string[] }
  flipStack: { value: number | null }
  flipSeat: { value: number | null }
  wallBreakIndex: { value: number }
  dealer: { value: number }
  startGame(mode?: MatchType, options?: Record<string, unknown>): unknown
  returnToLobby(): void
}