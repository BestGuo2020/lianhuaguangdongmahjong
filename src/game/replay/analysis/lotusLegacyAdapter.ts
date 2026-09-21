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
import { fingerprintOf } from './codec'
import type { AnalysisLegalAction, AnalysisSettlement, AnalysisWindowKind } from './types'

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
 * 窗口内区分动作的键（只取**能区分这个窗口内选项**的字段）：
 * 弃牌看手牌下标（同牌不同位置不是同一个选项）、补杠看副露下标、暗杠看牌、吃看组合，
 * 其余（胡/过/碰/直杠/风杠）在一个窗口里至多一个。`tile`/`from` 对吃与碰是冗余信息，不参与。
 */
export function actionMatchKey(action: LotusActionLike): string {
  switch (action.kind) {
    case 'discard': return `discard|${action.handIndex ?? -1}`
    case 'added-kong': return `added-kong|${action.meldIndex ?? -1}`
    case 'concealed-kong': return `concealed-kong|${action.tile ?? ''}`
    case 'chi': return `chi|${[...(action.meld ?? [])].sort().join(',')}`
    default: return action.kind
  }
}

/** 控制器返回的动作在该窗口合法动作里的下标；对不上返回 -1（不记成任何候选）。 */
export function chosenIndex(view: LotusSeatView, action: LotusActionLike | null): number {
  if (!action) return -1
  const key = actionMatchKey(action)
  return seatActionsOf(view).findIndex((candidate) => actionMatchKey(candidate) === key)
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
  return {
    id: decisionStateId(view),
    hand: [...view.hand],
    drawnTileIndex: view.drawnTileIndex,
    melds: view.melds.length,
    legalActions: legalActionsOf(view),
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
 * - 过牌 ⇒ 以上都没有变化才算生效。
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
      && after.handCount === before.handCount
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