// 权威命令条目：把「动作」折成可重跑的记录条目（§6、§10.6）。
//
// 为什么单独抽出来：这份映射原本只写在单机录制路径（`useBloodFlowGame.analysisCommandEntry`），
// 而联机权威端（引擎侧，见 engine.ts 的 `recordCommands`）也需要**逐字相同**的条目 ——
// §10.6 的第一个根因正是「两个写入方、两套写法」（一边存牌码、一边存中文显示名），
// 比较时必然假性失配。两处共用同一个函数，格式就不会再各自漂移。
import type { AnalysisReproduction } from './types'

/** 记录条目：与 `AnalysisReproduction.commands` 的元素同型（单一事实来源）。 */
export type AnalysisCommandEntry = NonNullable<AnalysisReproduction['commands']>[number]

/** 动作载荷：引擎的 `BloodFlowAction` 与网络报文里的动作都是这个形状。 */
interface ActionPayload {
  kind?: unknown
  tile?: unknown
  index?: unknown
  from?: unknown
  meldIndex?: unknown
  tiles?: unknown
  meld?: unknown
}

export interface CommandEntryOptions {
  at?: number
  /** 窗口内稳定 ID（与决策/候选对齐）；权威端没有这个口径就不写，绝不编一个。 */
  legalActionId?: string
  windowId?: string
  windowKind?: string
}

/**
 * 把动作折成记录条目。**必须带载荷**（牌种、当时手牌索引、组合牌集合、副露下标）：
 * 只记 `kind` 的话赛后无法重跑复现（§6、§10.6）。
 *
 * 牌一律记**牌码**（`south`），不转中文显示名：引擎候选本来就是牌码，两边同口径才不会假性失配。
 */
export function commandEntryFromAction(seat: number, action: unknown, options: CommandEntryOptions = {}): AnalysisCommandEntry {
  const payload = (action ?? {}) as ActionPayload
  const entry: AnalysisCommandEntry = { seat, kind: String(payload.kind ?? 'unknown'), at: options.at ?? Date.now() }
  if (options.legalActionId) entry.legalActionId = options.legalActionId
  if (options.windowId) entry.windowId = options.windowId
  if (options.windowKind) entry.windowKind = options.windowKind
  if (typeof payload.tile === 'string') entry.tile = payload.tile
  // 吃/杠不带单张 tile，必须把组合记下来，否则复现时只能按 kind 取第一个候选（实测会吃错组合）
  const combination = Array.isArray(payload.tiles) ? payload.tiles : Array.isArray(payload.meld) ? payload.meld : null
  if (combination?.length) entry.tiles = combination.filter((tile): tile is string => typeof tile === 'string')
  if (typeof payload.index === 'number') entry.handIndex = payload.index
  if (typeof payload.from === 'number' || payload.from === null) entry.from = payload.from as number | null
  if (typeof payload.meldIndex === 'number') entry.meldIndex = payload.meldIndex
  return entry
}

/**
 * 靠超时推进的条目（§11）：除窗口 id 外还记下**当时的窗口 kind 与等待座位**。
 * 只有 kind 才能回答「记录里的这个窗口编号到底是哪一类窗口」—— 校验器把它与重放同编号窗口的
 * kind 对照，就能区分「记录侧多压/少压 expire」与「权威端推进方式与记录不一致」。
 */
export function expireEntry(
  windowId: string,
  windowKind?: string,
  waitingSeats?: readonly number[],
  at = Date.now(),
): AnalysisCommandEntry {
  const entry: AnalysisCommandEntry = { seat: -1, kind: 'expire', at, resolution: 'expire', windowId }
  if (windowKind) entry.windowKind = windowKind
  if (waitingSeats) entry.waitingSeats = [...waitingSeats]
  return entry
}
