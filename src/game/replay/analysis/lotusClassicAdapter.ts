// 莲花广麻（lotus-classic）→ 分析模型的纯适配层（方案 §3.1／§3.2；约定 §1 属于 A 的路径）。
//
// 为什么要单独一层：游戏侧（useGame）只需调用几个纯函数，接线改动就能保持很小；
// 而"窗口怎么编号、前态该露出什么、这一手到底有没有生效、结算怎么折"这些容易出错的判断都能单测。
//
// 与血流 bloodFlowAdapter.ts 的口径对齐，但经典玩法是 **Vue 状态机**，三处必须不同（别照抄）：
// 1. 没有权威版本号 ⇒ 窗口 ID 用「本局内第 N 次进入决策」的自增计数，**不用时间戳/渲染帧号**，
//    这样两侧同编号的窗口才能对照，P1 的重放也才可能对齐（血流踩过：漏传 windowId 会让条目排到序列末尾）。
// 2. 没有权威账本 ⇒ 结算按**分数实际变化**折算，每次变化一条；四家变化之和恒为 0。
// 3. 没有权威回执 ⇒ 执行回执用"动作是否真的改了状态"判定；观察不到就保持 pending，
//    **绝不**因为"函数被调用过"就记 executed（§3.2、§10.2）。
import { fingerprintOf } from './codec'
import type { TableActionType, TileType } from '../../core/contracts/types'
import type { AnalysisDecisionState, AnalysisLegalAction, AnalysisSettlement, AnalysisWindowKind } from './types'

/** 经典玩法的三类决策窗口。 */
export type LotusClassicWindowKind = 'turn' | 'claim' | 'rob-kong'

/** 引擎动作的最小形状（与 TurnAction/ClaimAction 结构兼容，不直接依赖玩法类型）。 */
export interface LotusClassicActionLike {
  kind: string
  /** 牌种（弃牌/杠/被鸣的牌）。 */
  tile?: string
  /** 弃牌时的手牌下标：摸切/锁手语义靠它，不能只存牌种。 */
  handIndex?: number
  /** 被鸣/被胡的来源座位。 */
  from?: number | null
  /** 补杠关联的副露下标。 */
  meldIndex?: number
  /** 吃牌组合（广麻没有吃，保留给同一套读取侧口径）。 */
  meld?: string[]
}

/**
 * 一个座位的可见信息。
 * `hand` 只有**该座位自己**有牌面；别家这里给的是空数组 + `handCount` 张数（§10.4 隐私护栏）。
 * 构造视图时**故意**把四家真实手牌都放进来，好让"前态只露自己那一份"成为可测的护栏，
 * 而不是靠调用方自觉。
 */
export interface LotusClassicSeatView {
  seat: number
  /** 该座位手牌张数（别家只有这个数字）。 */
  handCount: number
  /** 该座位手牌；只有决策者本人这一份会被写进前态。 */
  hand: ReadonlyArray<string>
  /** 摸牌在手牌里的下标；-1 = 本回合没有摸牌（碰后直接出牌）。 */
  drawnTileIndex: number
  discards: ReadonlyArray<string>
  /** 公开副露（别家的副露本来就是公开信息）。 */
  melds: ReadonlyArray<unknown>
  score: number
}

/** 一次决策窗口的只读视图（由 useGame 从 LocalGameState + 控制器上下文折出来）。 */
export interface LotusClassicViewLike {
  /** 窗口 ID（`decisionWindowId` 的产物）：本局内稳定、跨局不重复。 */
  windowId: string
  roundId: string
  roundIndex: number
  /** 本视图是给哪个座位看的（该窗口的决策者，绝对座位）。 */
  seat: number
  windowKind: LotusClassicWindowKind
  /** 该座位此刻**引擎接受**的动作（由调用方从引擎决策上下文折出，见 useGame 的 legalActionsOf）。 */
  actions: ReadonlyArray<LotusClassicActionLike>
  players: ReadonlyArray<LotusClassicSeatView>
  wallCount: number
  dealer: number
  currentPlayer: number
  /**
   * 真实牌墙顺序（**未摸**的部分）。放在视图里是刻意的：前态一旦把它抄进去就是泄露，
   * 因此这里留着让"字段形状 + 遮蔽"的断言能真的抓到它（血流同款 d 用例）。
   */
  wall?: ReadonlyArray<string>
  /** 本局是否已结束（用于判定胡牌动作是否生效）。 */
  roundEnded?: boolean
  /** 本局赢家座位（未结束时为 null）。 */
  winningSeat?: number | null
}

/** 视为"胡"的动作类型（广麻只有自摸/抢杠胡，命名仍放宽匹配，别把胡漏判成普通动作）。 */
const WIN_KINDS = new Set(['win', 'hu', 'zimo', 'self-draw', 'discard-win', 'robbed-kong-win', 'kong-bloom'])
/** 视为"鸣牌"的动作类型（吃碰杠都要看副露有没有变多）。 */
const MELD_KINDS = new Set(['peng', 'chi', 'gang', 'added-kong', 'concealed-kong', 'wind-kong', 'discard-gang'])

/**
 * 窗口 ID：`` `${roundId}/window/${sequence}` ``，`sequence` 是**本局内第 N 次进入决策**的自增计数。
 * 与血流的 `${roundId}/window/${version}` 同形，便于两侧同编号对照；跨局不重复（序列每局清零）。
 */
export function decisionWindowId(roundId: string, sequence: number): string {
  return `${roundId}/window/${sequence}`
}

/** 窗口内稳定 ID：`${windowId}/${下标}`（与血流同一口径，四处引用才能对齐）。 */
export function legalActionId(windowId: string, index: number): string {
  return `${windowId}/${index}`
}

/** 把引擎动作规范化成分析用动作。 */
export function normalizeAction(windowId: string, index: number, action: LotusClassicActionLike): AnalysisLegalAction {
  const normalized: AnalysisLegalAction = { id: legalActionId(windowId, index), kind: action.kind }
  if (action.tile !== undefined) normalized.tile = action.tile
  if (action.handIndex !== undefined) normalized.handIndex = action.handIndex
  if (action.from !== undefined) normalized.from = action.from
  if (action.meldIndex !== undefined) normalized.meldIndex = action.meldIndex
  if (action.meld?.length) normalized.meld = [...action.meld]
  return normalized
}

export function legalActionsOf(windowId: string, actions: ReadonlyArray<LotusClassicActionLike>): AnalysisLegalAction[] {
  return actions.map((action, index) => normalizeAction(windowId, index, action))
}

/** 窗口类型：经典玩法的三类窗口直接对应，不做猜测。 */
export function windowKindOf(kind: LotusClassicWindowKind): AnalysisWindowKind {
  return kind === 'turn' ? 'draw-turn' : kind === 'claim' ? 'claim' : 'rob-kong'
}

/**
 * 反过来：引擎的窗口类型 → **记录口径**的窗口类型（`AnalysisWindowKind`）。
 *
 * 为什么需要这个方向：P1 的命令条目要与记录侧的窗口逐号对照（"第 N 个窗口是不是同一类窗口"），
 * 而两侧的词汇表不同 —— 记录侧（`AnalysisDecision.windowKind`、观测桩收到的 `window.windowKind`）
 * 用的是 `AnalysisWindowKind`（`draw-turn`/`claim`/`rob-kong`），引擎内部用的是
 * `LotusClassicWindowKind`（`turn`/`claim`/`rob-kong`）。直接拿两套字面量比，**第 1 个窗口
 * 就会报"类型对不上"**（实测：`记录 turn vs 重跑 draw-turn`）。
 *
 * 所以 `AnalysisCommandEntry.windowKind` 与决策记录**同一口径**写 `AnalysisWindowKind`
 * （`useGame` 里落命令时用的就是本函数的返回值），校验器再把它折回引擎词汇表去比。
 */
export function recordedWindowKindOf(kind: AnalysisWindowKind): LotusClassicWindowKind {
  if (kind === 'draw-turn') return 'turn'
  // 除了摸牌回合，本玩法只有"响应弃牌"与"抢杠"两类；`AnalysisWindowKind` 的其余取值
  // （血流的 `meld`/`win`…）在广麻的记录里不该出现，出现了就按响应窗口比 —— 但它会被
  // 窗口对照判成"类型对不上"，不会静默放过。
  return kind === 'rob-kong' ? 'rob-kong' : 'claim'
}

/** 决策前态 ID：同一 (窗口, 座位) 就是同一份前态（§9.3 禁止重复快照）。 */
export function decisionStateId(view: LotusClassicViewLike, seat: number): string {
  return `${view.windowId}/${seat}`
}

/**
 * 决策前态：**只含该座位当时可见的信息**（§10.4 隐私护栏）。
 * - 手牌/摸牌下标只写决策者本人那一份；别家暗手一个牌面都不出现；
 * - 未摸牌墙顺序**绝不**写入；
 * - 四家公开牌河/副露/分数由展示回放提供唯一来源（§9.3），这里不重复存，因此本就不在字段里。
 */
export function decisionStateOf(view: LotusClassicViewLike, seat: number): AnalysisDecisionState {
  const own = seat === view.seat
  const player = view.players[seat]
  return {
    id: decisionStateId(view, seat),
    fingerprint: fingerprintOf({
      windowId: view.windowId,
      seat,
      wallCount: view.wallCount,
      dealer: view.dealer,
      currentPlayer: view.currentPlayer,
      actions: view.actions.map((action) => [action.kind, action.tile, action.handIndex]),
    }),
    ...(own
      ? {
        hand: [...(player?.hand ?? [])],
        drawnTileIndex: player?.drawnTileIndex ?? -1,
        melds: player?.melds.length ?? 0,
      }
      : {}),
    legalActions: legalActionsOf(view.windowId, view.actions),
  }
}

/**
 * 这一手有没有真的生效（执行回执，§3.2、§10.2）。
 * 只认**该座位自己的可见变化**：
 * - 弃牌 ⇒ 牌河变长；吃碰杠 ⇒ 副露变多；胡 ⇒ 本局结束（赢家是该座位）；
 * - 过牌 ⇒ 以上都没有变化才算生效。
 * 判定不出来就返回 false，由调用方保持 pending 或记 state-changed ——
 * 请求成功 / 函数被调用过，都不等于动作执行成功。
 */
export function choiceTookEffect(
  before: LotusClassicViewLike,
  after: LotusClassicViewLike,
  seat: number,
  action: LotusClassicActionLike,
): boolean {
  const previous = before.players[seat]
  const next = after.players[seat]
  if (!previous || !next) return false
  if (MELD_KINDS.has(action.kind)) return next.melds.length > previous.melds.length
  if (action.kind === 'discard') return next.discards.length > previous.discards.length
  if (WIN_KINDS.has(action.kind)) {
    return Boolean(after.roundEnded) && after.winningSeat === seat
  }
  if (action.kind === 'pass') {
    return next.discards.length === previous.discards.length && next.melds.length === previous.melds.length
  }
  return false
}

/** 一次分数变化的输入：变化前后四家分数（按绝对座位）。 */
export interface LotusClassicScoreChange {
  roundIndex: number
  roundId: string
  /** 变化前分数（当局开局分或上一次变化后的分数）。 */
  before: ReadonlyArray<number>
  /** 变化后分数。 */
  after: ReadonlyArray<number>
  /** 结算类型：本局结束用 roundKindOfResult，局中分数流动用 'score-flow'。 */
  kind: string
  /** 触发这次变化的事件标识（用于把流水挂回展示回放）。 */
  sourceEventId: string
}

/**
 * 从**分数实际变化**派生结算流水（§5）。
 * 经典玩法没有权威账本，只有"分数变了多少"是可靠的：因此每条变化记一条，
 * `winners`/`payers` 由变化的正负号决定（与账本天然一致，不猜谁付谁）。
 * 四家变化之和为 0 是引擎的不变量；这里若发现不为 0 也照实记录（读取侧能看出来），不做修补。
 */
export function settlementsFromScoreChange(change: LotusClassicScoreChange): AnalysisSettlement {
  const deltas = change.after.map((score, seat) => score - (change.before[seat] ?? 0))
  return {
    id: `settlement/${change.roundId}/${change.sourceEventId}`,
    roundIndex: change.roundIndex,
    roundId: change.roundId,
    sourceEventId: change.sourceEventId,
    kind: change.kind,
    winners: deltas.map((delta, seat) => (delta > 0 ? seat : -1)).filter((seat) => seat >= 0),
    payers: deltas.map((delta, seat) => (delta < 0 ? seat : -1)).filter((seat) => seat >= 0),
    deltas,
    scoresAfter: [...change.after],
    batchId: change.sourceEventId,
    fingerprint: fingerprintOf({ deltas, after: change.after }),
  }
}

/** 本局结束的结算类型（自摸 / 点炮 / 抢杠 / 荒庄），供 settlementsFromScoreChange 的 kind。 */
export function roundKindOfResult(result: {
  draw?: boolean
  winType?: string
  robbedKong?: boolean
} | null): string {
  if (!result) return 'score-flow'
  if (result.draw) return 'draw'
  if (result.robbedKong) return 'robbed-kong-win'
  return result.winType === 'discard' ? 'win-discard' : 'self-draw'
}

/** Table animation events are observations; keep tile identity in engine codes. */
export function actionFromTableAction(type: TableActionType, tile: TileType, meldIndex: number): LotusClassicActionLike | null {
  if (type === 'peng' || type === 'chi') return { kind: type }
  if (type === 'added-gang') return { kind: 'added-kong', meldIndex }
  if (type === 'concealed-gang') return { kind: 'concealed-kong', tile }
  if (type === 'wind-kong') return { kind: 'wind-kong' }
  if (type === 'self-draw' || type === 'discard-win' || type === 'robbed-kong-win') return { kind: 'win' }
  if (type === 'discard-gang' || type === 'flower-gang') return { kind: 'gang' }
  return null
}
