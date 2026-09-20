// 血流视角 → 分析模型的纯适配层（方案 §3.2／§3.3／§3.4）。
//
// 为什么要单独一层：游戏侧（useBloodFlowGame）只需要调用几个纯函数，接线改动就能保持很小；
// 而"窗口类型怎么判、合法动作 ID 怎么定、这一手到底有没有生效"这些容易出错的判断都能单测。
//
// 约定：**窗口内稳定 ID = `${windowId}/${index}`**（index 是该座位在窗口 options 里的下标）。
// 同一窗口内下标稳定，因此 windowOpened / candidates / chosen / receipt 四处用同一套 ID 对得上。
import type { AnalysisLegalAction, AnalysisSettlement, AnalysisWindowKind } from './types'

/** 血流动作的最小形状（与 BloodFlowAction 结构兼容，不直接依赖玩法类型）。 */
export interface BloodFlowActionLike {
  kind: string
  tile?: string
  /** 弃牌时的手牌下标。 */
  index?: number
  /** 吃碰杠的来源座位；自摸/自己摸打为 undefined/null。 */
  from?: number | null
  meldIndex?: number
  /** 吃牌组合（若引擎给出）。 */
  meld?: string[]
  /** 引擎可能给出的候选组合（吃牌多解时）。 */
  tiles?: string[]
}

/** 座位视角里与分析相关的最小形状（字段名对照真实类型，见 bloodFlow/types.ts）。 */
export interface BloodFlowViewLike {
  seat: number
  roundId?: string
  authorityEpoch?: string
  window?: {
    id: string
    version: number
    opensAt?: number
    deadlineAt?: number
    options?: ReadonlyArray<ReadonlyArray<BloodFlowActionLike>>
    decisions?: ReadonlyArray<unknown | null>
  } | null
  ownActions?: ReadonlyArray<BloodFlowActionLike>
  /** 四家公开信息与手牌都在 players 里（牌河／副露／分数）。 */
  players?: ReadonlyArray<{
    hand?: ReadonlyArray<string>
    discards?: ReadonlyArray<string>
    melds?: ReadonlyArray<unknown>
    score?: number
  }>
  hand?: ReadonlyArray<string>
  drawnTileIndex?: number
  /**
   * public.seats 存的是每座**胡牌信息**（winCount/locked/recordIds），不是牌河；
   * 因此判定"胡牌是否生效"要看 winCount，而不是分数。
   */
  public?: { seats?: ReadonlyArray<{ winCount?: number; locked?: boolean; recordIds?: ReadonlyArray<string> }> }
}

const WIN_KINDS = new Set(['win', 'hu', 'zimo', 'self-draw', 'discard-win', 'robbed-kong-win', 'kong-bloom'])
const KONG_KINDS = new Set(['gang', 'concealed-kong', 'added-kong', 'wind-kong', 'gang-discard'])
const CLAIM_KINDS = new Set(['peng', 'chi', ...KONG_KINDS])

/** 窗口内稳定 ID（下标语义：同牌不同索引不会被混为同一个动作）。 */
export function legalActionId(windowId: string, index: number): string {
  return `${windowId}/${index}`
}

/** 把引擎的动作规范化成分析用动作。 */
export function normalizeAction(windowId: string, index: number, action: BloodFlowActionLike): AnalysisLegalAction {
  const normalized: AnalysisLegalAction = { id: legalActionId(windowId, index), kind: action.kind }
  if (action.tile !== undefined) normalized.tile = action.tile
  if (action.index !== undefined) normalized.handIndex = action.index
  if (action.from !== undefined) normalized.from = action.from
  if (action.meldIndex !== undefined) normalized.meldIndex = action.meldIndex
  const meld = action.meld ?? action.tiles
  if (meld?.length) normalized.meld = [...meld]
  return normalized
}

export function legalActionsOf(windowId: string, actions: ReadonlyArray<BloodFlowActionLike>): AnalysisLegalAction[] {
  return actions.map((action, index) => normalizeAction(windowId, index, action))
}

/**
 * 窗口类型。
 * 有弃牌选项 ⇒ 摸牌回合；否则是响应窗口（吃碰杠胡的过牌/拒胡都发生在这里）。
 * 抢杠与普通响应在视角里没有可靠区分字段，因此统一归到 claim——宁可粗一点，也不猜（§3.2）。
 */
export function windowKindOf(actions: ReadonlyArray<BloodFlowActionLike>): AnalysisWindowKind {
  if (actions.some((action) => action.kind === 'discard')) return 'draw-turn'
  if (actions.some((action) => CLAIM_KINDS.has(action.kind) || WIN_KINDS.has(action.kind))) return 'claim'
  return 'other'
}

/** 决策前态 ID：同一 (局, 窗口, 座位, 状态版本) 就是同一份前态（§9.3 禁止重复快照）。 */
export function decisionStateId(view: BloodFlowViewLike, seat: number): string {
  const round = view.roundId ?? 'round'
  const windowId = view.window?.id ?? 'window'
  const version = view.window?.version ?? 0
  return `${round}/${windowId}/${seat}/${version}`
}

/** 该座位此刻的合法动作（视角自己的 options 优先，其次 ownActions）。 */
export function seatLegalActions(view: BloodFlowViewLike, seat: number): ReadonlyArray<BloodFlowActionLike> {
  return view.window?.options?.[seat] ?? (seat === view.seat ? view.ownActions ?? [] : [])
}

/** 决策前态里"展示回放恢复不出来"的部分（§3.2、§9.3）。 */
export function decisionStateOf(view: BloodFlowViewLike, seat: number): {
  id: string
  hand: string[]
  drawnTileIndex: number
  melds: number
  legalActions: AnalysisLegalAction[]
} {
  const options = seatLegalActions(view, seat)
  const player = view.players?.[seat]
  const windowId = view.window?.id ?? 'window'
  return {
    id: decisionStateId(view, seat),
    hand: [...(seat === view.seat && view.hand ? view.hand : player?.hand ?? [])],
    drawnTileIndex: seat === view.seat ? view.drawnTileIndex ?? -1 : -1,
    melds: player?.melds?.length ?? 0,
    legalActions: legalActionsOf(windowId, options),
  }
}

/**
 * 从血流权威账本派生结算流水（§5）：每次胡牌批次 / 每次杠记一条，**只记引用不复制明细**。
 * 视图里的 batches 与 kongEvents 都是累计的，因此用已见集合去重（同一结算只记一次）。
 * 同一张牌的一炮多响保留同一 batchId（同源关系不丢）。
 */
export interface BloodFlowBatchLike {
  batchId: string
  source?: { id?: string; tile?: string; seat?: number; kind?: string }
  winners?: ReadonlyArray<{ winner: number; deltas?: readonly number[] }>
  deltas?: readonly number[]
  scoresAfter?: readonly number[]
}
export interface BloodFlowKongLike {
  id: string
  actor: number
  kongKind?: string
  sourceSeat?: number | null
  deltas?: readonly number[]
  scoresAfter?: readonly number[]
}
export interface BloodFlowLedgerViewLike {
  roundId?: string
  public?: { batches?: ReadonlyArray<BloodFlowBatchLike> }
  kongEvents?: ReadonlyArray<BloodFlowKongLike>
}

export function settlementsFromView(
  view: BloodFlowLedgerViewLike,
  roundIndex: number,
  seen: Set<string>,
): AnalysisSettlement[] {
  const out: AnalysisSettlement[] = []
  const roundId = view.roundId ?? 'round'
  for (const batch of view.public?.batches ?? []) {
    const key = `win/${batch.batchId}`
    if (seen.has(key)) continue
    seen.add(key)
    const winners = (batch.winners ?? []).map((record) => record.winner)
    // 付款座位：自摸是全桌（除赢家），点炮是放炮者 —— 由 deltas 的负号侧决定，天然与账本一致。
    const deltas = [...(batch.deltas ?? [])]
    const payers = deltas.map((delta, seat) => (delta < 0 ? seat : -1)).filter((seat) => seat >= 0)
    out.push({
      id: `settlement/${roundId}/${batch.batchId}`,
      roundIndex,
      roundId,
      sourceEventId: batch.source?.id ?? '',
      kind: batch.source?.kind === 'draw' ? 'self-draw' : 'win',
      winners,
      payers,
      deltas,
      scoresAfter: [...(batch.scoresAfter ?? [])],
      batchId: batch.batchId,
    })
  }
  for (const kong of view.kongEvents ?? []) {
    const key = `kong/${kong.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const deltas = [...(kong.deltas ?? [])]
    out.push({
      id: `settlement/${roundId}/${kong.id}`,
      roundIndex,
      roundId,
      sourceEventId: kong.id,
      kind: `kong-${kong.kongKind ?? 'unknown'}`,
      winners: kong.deltas && kong.deltas[kong.actor] > 0 ? [kong.actor] : [],
      payers: deltas.map((delta, seat) => (delta < 0 ? seat : -1)).filter((seat) => seat >= 0),
      deltas,
      scoresAfter: [...(kong.scoresAfter ?? [])],
      batchId: kong.id,
    })
  }
  return out
}

/**
 * 这一手有没有真的生效（用于执行回执，§3.4、§10.2）。
 * 只认**该座位自己的可见变化**：
 * - 弃牌 ⇒ 牌河变长；吃碰杠 ⇒ 副露变多；胡牌 ⇒ public.seats[seat].winCount 增加（分数变化作兜底）；
 * - 过牌 ⇒ 以上都没有变化才算生效。
 * 判定不出来就返回 false，由调用方记成 state-changed——请求成功不等于动作执行成功。
 */
export function choiceTookEffect(before: BloodFlowViewLike, after: BloodFlowViewLike, seat: number, action: BloodFlowActionLike): boolean {
  const player = (current: BloodFlowViewLike) => current.players?.[seat] ?? null
  const previous = player(before)
  const next = player(after)
  if (!previous || !next) return false
  const discardsBefore = previous.discards?.length ?? 0
  const discardsAfter = next.discards?.length ?? 0
  const meldsBefore = previous.melds?.length ?? 0
  const meldsAfter = next.melds?.length ?? 0
  if (CLAIM_KINDS.has(action.kind)) return meldsAfter > meldsBefore
  if (action.kind === 'discard') return discardsAfter > discardsBefore
  if (WIN_KINDS.has(action.kind)) {
    const winsBefore = before.public?.seats?.[seat]?.winCount ?? 0
    const winsAfter = after.public?.seats?.[seat]?.winCount ?? 0
    if (winsAfter !== winsBefore) return winsAfter > winsBefore
    // 视角没带胡牌计数时退回分数变化（点炮会立刻改分）
    return (previous.score ?? 0) !== (next.score ?? 0)
  }
  if (action.kind === 'pass') {
    return discardsAfter === discardsBefore && meldsAfter === meldsBefore
  }
  return false
}
