// 莲花麻将·翻精癞子视角 → 分析模型的纯适配层（方案 §3.1／§3.2／§3.4）。
//
// 与血流的差别：翻精癞子没有权威引擎的"窗口"对象，决策窗口由**编排层调用控制器**产生
// （`lotusTurnOrchestrator.ts` 的 requestTurn / requestDiscardHu / requestClaim / requestChi /
// requestRobKong）。因此这一层做两件事：
//   1. `lotusSeatView` —— 把本机牌桌状态投影成**该座位当时可见的信息**（§10.4 隐私护栏：
//      别家暗手恒为空数组，只给张数），并由规则基元复算出该窗口的合法动作；
//   2. 结算折算 —— 把一局的分数变化折成分析区的结算引用（§5）。
//
// 约定：**窗口内稳定 ID = `${windowId}/${index}`**（index 是该座位在这个窗口里的动作下标），
// 与血流同一套语义；因此 windowOpened / chosen / receipt 三处用同一套 ID 对得上。
//
// 窗口 ID 规则（§3.1 要求"可离线复算"）：`` `${roundId}/window/${counter}` ``，
// counter 是**本局内第 N 次进入决策**的自增计数（不是时间戳、不是渲染帧号）。
// 方案 §3.1 的草图写的是 `/turn/…`，但翻精癞子的窗口不止摸牌回合（还有碰杠吃响应与抢杠），
// 用 `/turn/` 会让响应窗口也挂上"回合"这个名字；这里统一用 `/window/`，
// 末段仍是单调递增的整数（与血流的 `${roundId}/window/${version}` 同形），
// 窗口**类型**另外记在 `AnalysisDecision.windowKind` 上 —— §11 的"两侧同编号窗口类型对照"
// 靠的是这个字段，不是 ID 里的字面量。
import type { Meld, TileType } from '../../core/contracts/types'
import type { RuleSet } from '../../core/rules/ruleset'
import type { ChiMeld } from '../../variants/lotus/lotusRules'
import { canChi, matchingCount, windKong } from '../../variants/lotus/lotusRules'
import type { LlmDecisionAnswerHookInput, LlmDecisionRequestHookInput } from '../../llm/llmController'
import { fingerprintOf } from './codec'
import { actionMatchKey, canonicalTileKey, type LotusActionKeyLike } from './lotusActionKey'
import type {
  AnalysisCandidate, AnalysisLegalAction, AnalysisLlmOutcome, AnalysisMaybe, AnalysisSettlement, AnalysisWindowKind,
} from './types'
import { known } from './types'
import type { AnalysisRecorder } from './recorder'

/** 触发一个决策窗口的控制器方法（编排层只在这五处询问座位）。 */
export type LotusDecisionMethod =
  | 'requestTurn'
  | 'requestDiscardHu'
  | 'requestClaim'
  | 'requestChi'
  | 'requestRobKong'

/**
 * 窗口类型（§3.2）。胡与碰/杠/吃都是"弃牌后的响应"，与血流同口径合并成 `claim`；
 * 抢杠有独立的等待语义（`pendingKong`），单列 `rob-kong`。
 */
export function windowKindOfMethod(method: LotusDecisionMethod): AnalysisWindowKind {
  if (method === 'requestTurn') return 'draw-turn'
  if (method === 'requestRobKong') return 'rob-kong'
  return 'claim'
}

/** 窗口内稳定 ID（下标语义：同牌不同位置不会被混为同一个动作）。 */
export function legalActionId(windowId: string, index: number): string {
  return `${windowId}/${index}`
}

/** 本局第 N 个决策窗口的 ID（§3.1：计数器而非时间，跨局不重复）。 */
export function windowIdOf(roundId: string, counter: number): string {
  return `${roundId}/window/${counter}`
}

/**
 * 本局的 roundId（与展示回放同一套口径）。
 *
 * 参数是**本局在整场里的序号**（1 起），不是 `state.round` —— 连庄（庄家连和／荒庄听牌）时
 * `state.round` 不变而只加 `honba`，拿它当键会让两局共用同一个 roundId：窗口 ID 会在两局之间
 * 重复，录制器按 `windowId#seat` 建决策对象就会把第二局的决策写进第一局那条记录里
 * （展示回放正是因为这个原因用"已打局数 + 1"而不是 `state.round`，见 `replay/recorder.ts`）。
 */
export function roundIdOf(roundSequence: number): string {
  return `round-${roundSequence}`
}

// ─────────────────────────────── 座位视角投影（§10.4） ───────────────────────────────

/** 该座位是不是 `from` 的下家（吃牌的唯一合法位置）。 */
export function isNextSeat(seatCount: number, seat: number, from: number | undefined): boolean {
  if (from === undefined || from < 0 || !seatCount) return false
  return seat === (from + 1) % seatCount
}

/** 牌桌上投影所需的字段（只读；别家手牌在投影时被遮蔽）。 */
export interface LotusTableSnapshot {
  players: ReadonlyArray<{
    hand: readonly TileType[]
    melds: readonly Meld[]
    discards: readonly TileType[]
    /** 本家摸到的牌在手牌里的下标；未摸为 -1（摸切/锁手依赖它，不能事后推）。 */
    drawnTileIndex?: number
    score?: number
  }>
  /** 本局精牌（万能牌）。 */
  jokers: readonly TileType[]
  /** 可替代精牌的实体牌（通常是白板）。 */
  wildcardTiles?: readonly TileType[]
}

/** 一个决策窗口的描述（由编排层的窗口计数器 + 触发方法构造）。 */
export interface LotusWindowDescriptor {
  windowId: string
  roundId: string
  kind: AnalysisWindowKind
  /** 绝对座位（不是本机视角的旋转座位）。 */
  seat: number
  /** 响应窗口：被弃（或被抢杠）的牌。 */
  tile?: TileType
  /** 响应窗口：打出这张牌的座位。 */
  from?: number
  /** 该座位是否跳过了摸牌（碰/吃后出牌、庄家开局）。 */
  skipDraw?: boolean
  /** 杠上开花（该座位这一手是杠后补摸）。 */
  kongBloom?: boolean
}

/** 别家的公开信息：**只有张数**，不含牌面（§10.4）。 */
export interface LotusOtherSeat {
  seat: number
  /** 恒为空数组：别家暗手不进决策输入。 */
  hand: TileType[]
  /** 只给张数。 */
  handCount: number
  meldCount: number
  discardCount: number
}

/** 该座位此刻的可见前态（= 引擎交给控制器的信息 + 规则复算出的合法动作）。 */
export interface LotusSeatView {
  seat: number
  roundId: string
  windowId: string
  kind: AnalysisWindowKind
  /** 本家手牌（含摸牌索引语义：摸切/锁手依赖它，不能只存牌种）。 */
  hand: TileType[]
  melds: Meld[]
  exposedMelds: number
  jokers: TileType[]
  /** 本家摸到的牌在手牌里的下标；未摸为 -1。 */
  drawnTileIndex: number
  /** 本家可胡（按引擎同一套规则基元复算）。 */
  canWin: boolean
  /** 可补杠的副露下标（碰且手里还有同牌）。 */
  addedKongIndexes: number[]
  /** 可暗杠的牌（手里 4 张）。 */
  concealedKongs: TileType[]
  /** 可风杠（东南西北各一）。 */
  windKong: boolean
  /** 响应窗口：被弃（被抢）的牌与来源；非响应窗口为 undefined。 */
  response?: { tile: TileType; from: number; canPeng: boolean; canGang: boolean; chiOptions: ChiMeld[] }
  /** 别家：**遮蔽后的**公开信息。 */
  others: LotusOtherSeat[]
}

/**
 * 把牌桌状态投影成某座位在某个决策窗口里的可见前态。
 *
 * 隐私护栏（§10.4）：只放该座位自己的手牌／副露／摸牌索引、四家公开的牌河与副露**张数**、
 * 精牌与窗口信息；**不得**出现别家暗手、未摸牌墙顺序。
 * 合法动作按引擎自己的规则基元复算（与 `lotusControllers` / `lotusTurnOrchestrator` 的判定同源）：
 * 手牌只含该座位自己的牌，因此这里复算出来的候选也只有它能看到的那些。
 */
export function lotusSeatView(
  snapshot: LotusTableSnapshot,
  window: LotusWindowDescriptor,
  ruleset: RuleSet,
): LotusSeatView {
  const seat = window.seat
  const player = snapshot.players[seat]
  const jokers = [...snapshot.jokers]
  const wildcardTiles = [...(snapshot.wildcardTiles ?? ['white'])]
  const hand = [...(player?.hand ?? [])]
  const melds = (player?.melds ?? []).map((meld) => ({ ...meld, tiles: [...meld.tiles] }))
  // 与共享 `structuralMeldCount` 同口径（花牌不算结构面子）；就地取用，避免把只读快照
  // 硬转成完整的 GamePlayer。
  const exposedMelds = melds.filter((meld) => meld.type !== 'flower').length
  const drawnTileIndex = window.skipDraw ? -1 : player?.drawnTileIndex ?? -1

  // 响应窗口：被弃（被抢）的牌参与鸣牌/胡牌判定，此时手里还没有这张牌。
  const responseTile = window.tile
  const isResponse = window.kind === 'claim' || window.kind === 'rob-kong'
  const winningTiles = responseTile ? [...hand, responseTile] : hand
  const ordinaryJokers = responseTile && (snapshot.jokers.includes(responseTile) || wildcardTiles.includes(responseTile))
    ? [responseTile]
    : []

  const canWin = window.kind === 'rob-kong'
    ? Boolean(responseTile) && ruleset.win.canRobKong(hand, responseTile!, exposedMelds, {
      jokers, jokerSubstitutes: wildcardTiles,
    })
    : ruleset.win.isWinningHand(winningTiles, exposedMelds, {
      jokers, ordinaryJokers, jokerSubstitutes: wildcardTiles,
    })
  const concealed = ruleset.win.concealedKongs(hand, { jokers })
  const addedKongIndexes = melds.reduce<number[]>((out, meld, index) => {
    // 与编排层 `handleAction` 的补杠判定同源：必须是碰出来的面子且手里还有同牌。
    if (meld.type === 'peng' && hand.includes(meld.tile)) out.push(index)
    return out
  }, [])
  const response = isResponse && responseTile
    ? {
      tile: responseTile,
      from: window.from ?? -1,
      canPeng: window.kind === 'rob-kong' ? false : matchingCount(hand, responseTile) >= 2,
      canGang: window.kind === 'rob-kong' ? false : matchingCount(hand, responseTile) >= 3,
      // 吃只有弃牌**下家**能吃（与编排层的 `playerIndex === (from + 1) % players.length` 同口径）；
      // 少了这道闸，记录里会出现别家根本不能选的吃选项。
      chiOptions: window.kind === 'rob-kong' || !isNextSeat(snapshot.players.length, seat, window.from)
        ? []
        : canChi(hand, responseTile, jokers),
    }
    : undefined

  return {
    seat,
    roundId: window.roundId,
    windowId: window.windowId,
    kind: window.kind,
    hand,
    melds,
    exposedMelds,
    jokers,
    drawnTileIndex,
    canWin,
    addedKongIndexes,
    concealedKongs: [...concealed],
    windKong: windKong(hand, jokers),
    ...(response ? { response } : {}),
    // 别家：张数是公开的，牌面一律遮蔽（空数组）。
    others: snapshot.players
      .map((other, index) => ({
        seat: index,
        hand: [] as TileType[],
        handCount: other.hand.length,
        meldCount: other.melds.length,
        discardCount: other.discards.length,
      }))
      .filter((entry) => entry.seat !== seat),
  }
}

// ─────────────────────────────── 合法动作（§3.2／§3.3） ───────────────────────────────

/** 规范化动作的形状（与 `AnalysisLegalAction` 的字段一一对应）。 */
export interface LotusActionLike {
  kind: string
  tile?: TileType
  handIndex?: number
  from?: number | null
  meld?: TileType[]
  meldIndex?: number
}

export function normalizeAction(windowId: string, index: number, action: LotusActionLike): AnalysisLegalAction {
  const normalized: AnalysisLegalAction = { id: legalActionId(windowId, index), kind: action.kind }
  if (action.tile !== undefined) normalized.tile = action.tile
  if (action.handIndex !== undefined) normalized.handIndex = action.handIndex
  if (action.from !== undefined) normalized.from = action.from
  if (action.meldIndex !== undefined) normalized.meldIndex = action.meldIndex
  if (action.meld?.length) normalized.meld = [...action.meld]
  return normalized
}

/**
 * 该座位此刻的合法动作（顺序即 ID 下标）。
 * 顺序照编排层的响应优先级：胡 > 杠 > 碰 > 吃 > 过；摸牌回合是 胡 > 杠 > 弃牌。
 */
export function seatActionsOf(view: LotusSeatView): LotusActionLike[] {
  if (view.kind === 'rob-kong') {
    return view.canWin ? [{ kind: 'win' }, { kind: 'pass' }] : [{ kind: 'pass' }]
  }
  if (view.kind === 'claim') {
    const options: LotusActionLike[] = []
    if (view.canWin) options.push({ kind: 'win' })
    if (view.response?.canGang) options.push({ kind: 'gang' })
    if (view.response?.canPeng) options.push({ kind: 'peng' })
    for (const option of view.response?.chiOptions ?? []) {
      options.push({ kind: 'chi', tile: view.response!.tile, from: view.response!.from, meld: [...option.tiles] })
    }
    options.push({ kind: 'pass' })
    return options
  }
  if (view.kind === 'draw-turn') {
    const options: LotusActionLike[] = []
    if (view.canWin) options.push({ kind: 'win' })
    for (const meldIndex of view.addedKongIndexes) {
      options.push({ kind: 'added-kong', meldIndex, tile: view.melds[meldIndex]?.tile })
    }
    for (const tile of view.concealedKongs) options.push({ kind: 'concealed-kong', tile })
    if (view.windKong) options.push({ kind: 'wind-kong' })
    view.hand.forEach((tile, handIndex) => options.push({ kind: 'discard', tile, handIndex }))
    return options
  }
  return []
}

export function legalActionsOf(view: LotusSeatView): AnalysisLegalAction[] {
  return seatActionsOf(view).map((action, index) => normalizeAction(view.windowId, index, action))
}

/**
 * 控制器返回的动作 → 分析用动作。
 * 形状有三套：回合/鸣牌的动作对象（`{kind, handIndex|tile|meldIndex}`）、
 * 吃的动作对象（`{kind:'chi', meld: ChiMeld}`）、以及抢杠的**裸字符串**（`'win' | 'pass'`）。
 * 碰带的 `discardIndex` 是"碰完之后弃哪张"，属于下一个动作，不进本窗口的动作标识。
 */
export function toLotusActionLike(action: unknown): LotusActionLike | null {
  if (typeof action === 'string') {
    return action === 'win' || action === 'pass' ? { kind: action } : null
  }
  if (!action || typeof action !== 'object') return null
  const raw = action as { kind?: unknown; tile?: unknown; handIndex?: unknown; meldIndex?: unknown; meld?: unknown }
  if (typeof raw.kind !== 'string') return null
  const normalized: LotusActionLike = { kind: raw.kind }
  if (typeof raw.tile === 'string') normalized.tile = raw.tile as TileType
  if (typeof raw.handIndex === 'number') normalized.handIndex = raw.handIndex
  if (typeof raw.meldIndex === 'number') normalized.meldIndex = raw.meldIndex
  const meld = raw.meld as { tiles?: unknown } | undefined
  if (meld && Array.isArray(meld.tiles)) normalized.meld = [...(meld.tiles as TileType[])]
  return normalized
}

/**
 * 可以参与匹配键的动作：`tile`/`meld` 既可能是本适配层的 `TileType` 牌码（`m5`），
 * 也可能是 LLM 接缝上报的**中文显示名**（`五万`，`llmController` 的 `analysisLegalActionOf`
 * 走的是 `tileName()`）。所以这里收宽松的 `string`。
 *
 * 实现与 `canonicalTileKey`/`actionMatchKey` 已经抽到 `lotusActionKey.ts`：广麻的重跑校验器
 * 用的是**同一套**键函数（两个玩法的动作区分语义完全一致），分散成两份实现迟早会在
 * "补杠看副露下标"这种细节上漂移。
 */
export type ActionKeyLike = LotusActionKeyLike

/** 见 `lotusActionKey.ts`：牌面 → 规范键（牌码），两套中文牌名（中文数字/阿拉伯数字）都认。 */
export { actionMatchKey, canonicalTileKey }

/** 控制器返回的动作在该窗口合法动作里的下标；对不上返回 -1（不记成任何候选）。 */
export function chosenIndex(view: LotusSeatView, action: LotusActionLike | null): number {
  if (!action) return -1
  const key = actionMatchKey(action)
  return seatActionsOf(view).findIndex((candidate) => actionMatchKey(candidate) === key)
}

// ─────────────────────────────── LLM 接缝（§4／§5） ───────────────────────────────
//
// 为什么放在这个文件里：约定 §1 给 B 的路径只有 `lotusLegacyAdapter.ts(+test)`，
// 而方案 §1.4 要求每个玩法各有一份「决策接缝」的对应物（血流那份是 `decisionSink.ts`）。
// 于是接缝与投影放在同一模块，分节隔开：`lotusSeatView` 及以上是**纯函数**，以下是**有副作用的接缝**。

/** 钩子上报的动作是 `unknown`：只读我们认得的字段，认不出来就返回 null（不猜）。 */
export function analysisActionLikeOf(action: unknown): AnalysisLegalAction | null {
  if (!action || typeof action !== 'object') return null
  const raw = action as { kind?: unknown; tile?: unknown; handIndex?: unknown; meldIndex?: unknown; meld?: unknown }
  if (typeof raw.kind !== 'string') return null
  const normalized: AnalysisLegalAction = { id: '', kind: raw.kind }
  if (typeof raw.tile === 'string') normalized.tile = raw.tile
  if (typeof raw.handIndex === 'number') normalized.handIndex = raw.handIndex
  if (typeof raw.meldIndex === 'number') normalized.meldIndex = raw.meldIndex
  if (Array.isArray(raw.meld) && raw.meld.every((tile) => typeof tile === 'string')) {
    normalized.meld = [...(raw.meld as string[])]
  }
  return normalized
}

/**
 * 把 LLM 接缝上报的候选／推荐**改挂到本窗口的合法动作上**（§3.3、§4）。
 *
 * 为什么必须改挂：钩子里的 ID 是它自己的编号空间（`${引擎侧 requestId}/${下标}`），
 * 而分析区的决策按本适配层自己的窗口号建（§6）。两套编号混用会让候选指向一个不存在的合法动作。
 * 按**动作内容**对齐（与血流 `mapCandidatesToLegalActions` 同一思路）；对不上的只计数，
 * 不猜它的合法动作 ID、也不静默当成空集（§9.5 缺失要留痕）。
 *
 * **取动作必须优先用 `reportedLegalActions`（钩子的合法动作表），不能用 `candidate.action`**：
 * 后者是**引擎侧**的原始规范动作 —— 吃只有 `{kind:'chi', optionIndex}`，组合在合法动作表那一份上。
 * 只用 `candidate.action` 会把每一个吃候选都判成"认不出来"（实测：真机 e2e 抓到过一次，
 * 落库时静默少一个候选）。两张表按 `id` 一一对应（钩子的约定）。
 */
export function rebaseHookCandidates(
  windowId: string,
  legalActions: readonly AnalysisLegalAction[],
  input: {
    /** 钩子上报的合法动作（带组合/下标语义的那一份）。 */
    reportedLegalActions?: ReadonlyArray<AnalysisLegalAction>
    candidates: ReadonlyArray<{ id: string; label?: string; summary?: string; action: unknown }>
    recommended?: { candidateId: string; note?: string }
  },
): {
  candidates: AnalysisCandidate[]
  recommended?: AnalysisMaybe<{ legalActionId: string; note?: string }>
  unmapped: number
  /** 对不上的那些动作的匹配键（诊断用：只看数量查不出是哪种动作对不上）。 */
  unmappedKeys: string[]
} {
  const indexOfKey = new Map<string, number>()
  legalActions.forEach((action, index) => indexOfKey.set(actionMatchKey(action), index))
  const reportedById = new Map<string, AnalysisLegalAction>()
  for (const action of input.reportedLegalActions ?? []) {
    if (action.id) reportedById.set(action.id, action)
  }
  const candidates: AnalysisCandidate[] = []
  const indexById = new Map<string, number>()
  const unmappedKeys: string[] = []
  for (const candidate of input.candidates) {
    const reported = reportedById.get(candidate.id) ?? analysisActionLikeOf(candidate.action)
    const key = reported ? actionMatchKey(reported) : '(认不出来)'
    const index = indexOfKey.get(key)
    // 诊断要能直接看出"差在哪"：报对不上的键、原始动作，以及**本窗口同一类动作的键**
    if (index === undefined) {
      const sameKind = legalActions
        .filter((action) => action.kind === reported?.kind)
        .map((action) => actionMatchKey(action))
      unmappedKeys.push(`${key || '(空键)'} <- ${JSON.stringify(reported ?? candidate.action).slice(0, 80)}`
        + `（本窗口同类：${sameKind.join(' | ') || '无'}）`)
      continue
    }
    indexById.set(candidate.id, index)
    // 动作取**本窗口的**那一份：记录里的候选动作必须与 decisionState.legalActions 逐字一致
    candidates.push({
      legalActionId: legalActionId(windowId, index),
      action: { ...legalActions[index]! },
      ...(candidate.label ?? candidate.summary ? { reason: candidate.label ?? candidate.summary } : {}),
    })
  }
  const recommendedIndex = input.recommended ? indexById.get(input.recommended.candidateId) : undefined
  return {
    candidates,
    ...(recommendedIndex === undefined
      ? {}
      : {
        recommended: known({
          legalActionId: legalActionId(windowId, recommendedIndex),
          ...(input.recommended!.note ? { note: input.recommended!.note } : {}),
        }),
      }),
    unmapped: unmappedKeys.length,
    unmappedKeys,
  }
}

/**
 * 把钩子的 `promptVariables` 拆成"模板正文"与"逐次变量"（§4）：
 * `system` 是模板正文，交给 `recorder.promptTemplate({ id, content })` **按 id 只存一次**，
 * 之后每次决策只存其余变量（`user` 仍是逐字的那一份）。
 * 不拆的话，模板全文会在每一条尝试里各留一份副本 —— 正是 §4 明令不要的"全文提示词重复副本"。
 */
export function splitTemplateVariables(variables: unknown): { system: string | null; rest: Record<string, unknown> } {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return { system: null, rest: {} }
  const { system, ...rest } = variables as Record<string, unknown>
  return { system: typeof system === 'string' ? system : null, rest }
}

/** 钩子的结束结果 → 分析区的结果枚举；guarded 保留有效但被策略护栏拒绝的原回答。 */
const LLM_OUTCOME: Record<LlmDecisionAnswerHookInput['outcome'], AnalysisLlmOutcome> = {
  success: 'success',
  invalid: 'candidate-missing',
  guarded: 'policy-rejected',
  timeout: 'timeout',
  error: 'network-error',
}

/** 用量只在钩子真的给了数字时才记（拿不到就不填，绝不填 0 冒充，§3.3）。 */
export function usageOf(usage: unknown): Record<string, number> | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return Object.keys(out).length ? out : null
}

export interface LotusLegacyDecisionSinkOptions {
  /**
   * 录制器（分析会话的稳定代理）。
   * **可以传 getter**：App 里 LLM 控制器（`createLotusLlmControllers`）比分析会话**先**创建，
   * 而接缝的 hooks 又必须在构造控制器时给出去 —— 传 getter 就不必为了接缝去调 App 的初始化顺序。
   */
  recorder: AnalysisRecorder | (() => AnalysisRecorder | null | undefined)
  /** Actual local strategy used after a failed request; classic and flip-joker differ. */
  fallbackStrategy?: string
  onError?(detail: string): void
}

export interface LotusLegacyDecisionSink {
  /** 合并进 `createLotusLlmControllers` 的 `LlmControllerHooks`（与既有钩子共存）。 */
  hooks: {
    onDecisionRequest(input: LlmDecisionRequestHookInput): void
    onDecisionAnswer(input: LlmDecisionAnswerHookInput): void
  }
  /**
   * 引擎侧：一个决策窗口开始（前态已落库、控制器即将被询问）。
   * 钩子只知道 `seat`，所以由这里维护"该座位当前在飞的窗口"，钩子触发时按 seat 查它 ——
   * 这正是 `LlmDecisionRequestHookInput.windowId` 注释里推荐的做法。
   */
  windowOpened(input: { seat: number; windowId: string; legalActions: readonly AnalysisLegalAction[] }): void
  /** 引擎侧：窗口的决策已经作出（选择与来源已记），不再接受该窗口的尝试关联。 */
  windowClosed(seat: number): void
}

/**
 * 创建翻精癞子的 LLM 记录接缝（§4／§5）。钩子只在**真的发请求**时触发，所以这里不新增请求、
 * 不改变回退行为；接缝自身绝不抛错，异常只上报一次（§9.5 独立失败域）。
 *
 * **由 App 侧创建一次、引擎侧登记窗口**（而不是由 `useLotusGame` 自己建）：
 * 控制器是在 `useLotusGame` 之前就构造好的（`aiControllers` 是它的入参），
 * 钩子必须在那之前就位；反过来让端口暴露钩子会绕成"引擎要控制器、控制器要引擎"的循环依赖。
 * 于是所有权对调：接缝独立存在，引擎通过 `windowOpened`/`windowClosed` 告诉它"现在在飞的是哪个窗口"。
 */
export function createLotusLegacyDecisionSink(options: LotusLegacyDecisionSinkOptions): LotusLegacyDecisionSink {
  /** 每次用到时再取（见 `recorder` 的说明）：没有会话时直接不记，也没什么可留痕的。 */
  const recorderOf = (): AnalysisRecorder | null => (
    typeof options.recorder === 'function' ? options.recorder() ?? null : options.recorder
  )
  /** 引擎侧 `requestId` → 这次尝试（钩子的开始/结束只靠它关联）。 */
  const attempts = new Map<string, { attemptId: string; windowId: string; seat: number }>()
  /** 该座位当前在飞的窗口（钩子按 seat 查它）。 */
  const inFlight = new Map<number, { windowId: string; legalActions: readonly AnalysisLegalAction[] }>()
  let reported = false

  function report(detail: string) {
    if (reported) return
    reported = true
    try { options.onError?.(detail) } catch { /* 通知自身也要安全 */ }
  }

  function safe(run: () => void, label: string) {
    try {
      run()
    } catch (error) {
      report(`分析接缝 ${label} 失败：${String(error).slice(0, 160)}`)
    }
  }

  return {
    windowOpened(input) {
      inFlight.set(input.seat, { windowId: input.windowId, legalActions: input.legalActions })
    },

    windowClosed(seat) {
      inFlight.delete(seat)
    },

    hooks: {
      onDecisionRequest(input) {
        safe(() => {
          const recorder = recorderOf()
          if (!recorder) return
          const window = inFlight.get(input.seat)
          if (!window) {
            // 找不到在飞的窗口就不写：宁可留痕，也不落一条没有归属（关联不上决策）的尝试
            report(`模型请求找不到对应的分析窗口（seat=${input.seat}）`)
            return
          }
          const rebased = rebaseHookCandidates(window.windowId, window.legalActions, {
            reportedLegalActions: input.legalActions,
            candidates: input.candidates,
            ...(input.recommended ? { recommended: input.recommended } : {}),
          })
          recorder.candidates({
            windowId: window.windowId,
            seat: input.seat,
            legalActions: [...window.legalActions],
            candidates: rebased.candidates,
            ...(rebased.recommended ? { recommended: rebased.recommended } : {}),
          })
          if (rebased.unmapped > 0) {
            report(`窗口 ${window.windowId}（seat=${input.seat}）有 ${rebased.unmapped} 个候选无法对应到本窗口的合法动作`
              + `（未记录其合法 ID）：${rebased.unmappedKeys.join(' / ')}`)
          }
          const variables = splitTemplateVariables(input.promptVariables)
          if (variables.system !== null) {
            // 录制器按 id 去重：同一个模板再登记也是空操作（§4）
            recorder.promptTemplate({ id: input.promptTemplateId, content: variables.system })
          }
          const attemptId = recorder.attemptStarted({
            decisionWindowId: window.windowId,
            seat: input.seat,
            requestId: input.requestId,
            attempt: 1,
            provider: input.provider,
            requestModel: input.model,
            // 采样/思考开关：本层拿不到（钩子不暴露 temperature 这类参数）⇒ 留空，不编。
            sampling: {},
            promptTemplateId: input.promptTemplateId,
            promptVariables: variables.rest,
          })
          // 来源先记模型；回退时在 answer 里改成 model-fallback（§4）
          recorder.source({ windowId: window.windowId, seat: input.seat, source: 'model' })
          if (attemptId) attempts.set(input.requestId, { attemptId, windowId: window.windowId, seat: input.seat })
        }, 'onDecisionRequest')
      },

      onDecisionAnswer(input) {
        const tracked = attempts.get(input.requestId)
        if (!tracked) return
        attempts.delete(input.requestId)
        safe(() => {
          const recorder = recorderOf()
          if (!recorder) return
          const usage = usageOf(input.usage)
          const fallback = input.fallback ? { reason: input.fallback.reason, strategy: options.fallbackStrategy ?? 'lotus-local-ai' } : null
          recorder.attemptFinished(tracked.attemptId, {
            outcome: LLM_OUTCOME[input.outcome],
            ...(input.responseModel ? { responseModel: known(input.responseModel) } : {}),
            ...(input.raw || input.choice
              ? { answer: known({ text: input.raw, ...(input.choice ? { candidateId: input.choice } : {}) }) }
              : { answer: { known: false as const } }),
            ...(fallback ? { fallback } : {}),
            ...(usage ? { usage } : {}),
          })
          // 来源要跟着回退改：不然后续的本地兜底动作会被归因成模型的选择（§4、§10.1）
          recorder.source({
            windowId: tracked.windowId,
            seat: tracked.seat,
            source: fallback ? 'model-fallback' : 'model',
          })
        }, 'onDecisionAnswer')
      },
    },
  }
}

/** 决策窗口（§3.1）：谁、什么时候、有哪些合法动作。窗口没有可选动作时返回 null。 */
export function decisionWindowOf(view: LotusSeatView): {
  windowId: string
  kind: AnalysisWindowKind
  seat: number
  legalActions: AnalysisLegalAction[]
} | null {
  const legalActions = legalActionsOf(view)
  if (!legalActions.length) return null
  return { windowId: view.windowId, kind: view.kind, seat: view.seat, legalActions }
}

// ─────────────────────────────── 决策前态（§3.2／§9.3） ───────────────────────────────

/**
 * 决策前态：**只含展示回放恢复不出来的部分**（§9.3）。
 * 字段形状是固定的一套（多出任何字段都说明有人把新信息塞进了决策输入），
 * 别家暗手既不在 `hand` 里也不在任何其他字段里。
 */
export interface LotusDecisionState {
  id: string
  fingerprint: string
  hand: string[]
  drawnTileIndex: number
  melds: number
  legalActions: AnalysisLegalAction[]
}

/** 前态 ID：同一 (窗口, 座位) 就是同一份前态（§9.3 禁止重复快照）。 */
export function decisionStateId(view: LotusSeatView): string {
  return `${view.windowId}/${view.seat}`
}

export function decisionStateOf(view: LotusSeatView): LotusDecisionState {
  const legalActions = legalActionsOf(view)
  return {
    id: decisionStateId(view),
    fingerprint: fingerprintOf({
      windowId: view.windowId, seat: view.seat, kind: view.kind,
      hand: view.hand, drawnTileIndex: view.drawnTileIndex,
      melds: view.melds, jokers: view.jokers, response: view.response,
      others: view.others, legalActions,
    }),
    hand: [...view.hand],
    drawnTileIndex: view.drawnTileIndex,
    melds: view.melds.length,
    legalActions,
  }
}

// ─────────────────────────────── 执行回执（§3.4／§10.2） ───────────────────────────────

/** 该座位自己的**可见**变化指纹：动作有没有真的改状态，只看这几个量。 */
export interface LotusSeatObservable {
  handCount: number
  meldCount: number
  discardCount: number
  /** 已解决的面子动作（暗杠/风杠不产生副露，用分数与牌河变化兜底）。 */
  score: number
}

export function observableOf(snapshot: LotusTableSnapshot, seat: number): LotusSeatObservable {
  const player = snapshot.players[seat]
  return {
    handCount: player?.hand.length ?? 0,
    meldCount: player?.melds.length ?? 0,
    discardCount: player?.discards.length ?? 0,
    score: player?.score ?? 0,
  }
}

/**
 * 这一手有没有真的生效（§3.4、§10.2）。
 *
 * 翻精癞子是 Vue 状态机，没有权威回执，所以只能看"该座位自己的可见变化"：
 * - 弃牌 ⇒ 牌河变长；碰/吃/杠 ⇒ 副露变多或手牌变短（暗杠/风杠不留副露）；胡 ⇒ 分数变化；
 * - 过牌 ⇒ 没有自己的弃牌或副露变化；引擎随后可能已补摸，手牌张数可以变化。
 * 判定不出来就返回 false，由调用方记成 `state-changed` —— 选择被接受 ≠ 动作执行成功。
 */
export function choiceTookEffect(
  before: LotusSeatObservable,
  after: LotusSeatObservable,
  action: LotusActionLike,
): boolean {
  if (action.kind === 'discard') return after.discardCount > before.discardCount
  if (action.kind === 'pass') {
    return after.discardCount === before.discardCount
      && after.meldCount === before.meldCount
  }
  if (action.kind === 'win') return after.score !== before.score
  if (action.kind === 'added-kong' || action.kind === 'concealed-kong' || action.kind === 'wind-kong') {
    return after.meldCount > before.meldCount || after.handCount < before.handCount || after.score !== before.score
  }
  // 碰/吃/直杠：副露变多，或手牌变短（吃碰各消耗手牌）
  return after.meldCount > before.meldCount || after.handCount < before.handCount
}

// ─────────────────────────────── 结算折算（§5） ───────────────────────────────

export interface LotusRoundSettlementInput {
  roundIndex: number
  roundId: string
  /** 当局开局分数（与传给引擎的开局读数同一时刻取）。 */
  openingScores: readonly number[]
  /** 局末分数。 */
  endingScores: readonly number[]
  result: {
    draw?: boolean
    winnerIndex?: number
    winType?: string
    robbedKongPlayerIndex?: number
  } | null
}

/**
 * 把一局的分数变化折成分析区的结算引用（§5）：**每局一条**，只记引用不复制明细。
 *
 * 口径：`deltas = 局末分 − 开局分`（因此四家之和恒等于牌流本身的守恒量，
 * 单测直接断言它是 0）；付款座位由 deltas 的负号侧决定，天然与牌桌一致。
 * 单笔杠分与跟庄的**逐笔**流水没有单列（本阶段范围，见
 * `docs/blood-flow/design/analysis-lotus-legacy.md` 的「未做的部分」）。
 */
export function settlementsFromRound(input: LotusRoundSettlementInput): AnalysisSettlement[] {
  const { roundIndex, roundId, openingScores, endingScores } = input
  if (!endingScores.length || endingScores.length !== openingScores.length) return []
  const deltas = endingScores.map((score, seat) => score - (openingScores[seat] ?? 0))
  const winners = input.result?.draw || input.result?.winnerIndex === undefined
    ? []
    : [input.result.winnerIndex]
  return [{
    id: `settlement/${roundId}/${roundIndex}`,
    roundIndex,
    roundId,
    sourceEventId: `${roundId}/end`,
    kind: input.result?.draw ? 'draw' : `win-${input.result?.winType ?? 'unknown'}`,
    winners,
    payers: deltas.map((delta, seat) => (delta < 0 ? seat : -1)).filter((seat) => seat >= 0),
    deltas,
    scoresAfter: [...endingScores],
    batchId: `${roundId}/end`,
    // 指纹取"分数向量"：与展示回放结算比对时用它，整场分数是否守恒也能一眼看出（§5）。
    fingerprint: fingerprintOf({ openingScores: [...openingScores], endingScores: [...endingScores] }),
  }]
}

/** One actual transfer, or a zero-delta round-end marker for replay score checks. */
export function lotusSettlementFromScoreChange(input: {
  roundIndex: number
  roundId: string
  before: readonly number[]
  after: readonly number[]
  kind: string
  sourceEventId: string
}): AnalysisSettlement {
  const deltas = input.after.map((score, seat) => score - (input.before[seat] ?? 0))
  return {
    id: `settlement/${input.roundId}/${input.sourceEventId}`,
    roundIndex: input.roundIndex,
    roundId: input.roundId,
    sourceEventId: input.sourceEventId,
    kind: input.kind,
    winners: deltas.map((delta, seat) => delta > 0 ? seat : -1).filter((seat) => seat >= 0),
    payers: deltas.map((delta, seat) => delta < 0 ? seat : -1).filter((seat) => seat >= 0),
    deltas,
    scoresAfter: [...input.after],
    batchId: input.sourceEventId,
    fingerprint: fingerprintOf({ before: input.before, after: input.after, kind: input.kind }),
  }
}
