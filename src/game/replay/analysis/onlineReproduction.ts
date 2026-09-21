// §6 赛后私有复现数据的**联机形态**：权威端在局后产出一局的初始牌墙／手牌／开局参数与完整权威
// 命令序列，经中继下发给各客户端，各自写进本机分析区。
//
// 三条不许含糊的约束：
// 1. **只在局后**产生与下发：对局进行中把牌墙或对手暗手发给普通客户端就是泄露（§6）。
//    `buildReproductionPayload` 由权威端在 `onRoundSettled` 之后调用，进行中的局拿不到 `roundResult`。
// 2. 收到的东西是**网络输入**：字段、牌名、长度、命令规模全部严格校验，坏数据一律拒绝并给出原因，
//    绝不用默认值顶替（缺字段的记录重跑出来是另一个局面，却会被判"复现成功"）。
// 3. 拿不到就如实说拿不到（`unavailableReason`），不猜测补齐（§6、§9.5）。
import { TILE_TYPES } from '../../core/rules/tiles'
import { SEATS } from '../../variants/lotus/bloodFlow/state'
import { utf8Bytes } from './codec'
import type { AnalysisCommandEntry } from './commandEntry'
import type { AnalysisReproduction } from './types'

/** 载荷格式版本（与 `ANALYSIS_FORMAT_VERSION` 分开：传输形态可以独立演进）。 */
export const ANALYSIS_REPRODUCTION_FORMAT_VERSION = 1

/** 单局载荷上限：畸形/恶意数据不得把客户端拖死（正常一局远小于此）。 */
export const ANALYSIS_REPRODUCTION_MAX_BYTES = 512 * 1024
/** 单局命令条数上限：血流的窗口数有物理上界，超过就是坏数据。 */
export const ANALYSIS_REPRODUCTION_MAX_COMMANDS = 4_000

/** 权威引擎侧的开局快照（`BloodFlowEngine.initialOpening` 的结构化子集）。 */
export interface EngineOpeningSnapshot {
  players: Array<{ hand: readonly string[]; score: number }>
  wall: readonly string[]
  flipTiles: readonly string[]
  jokers: readonly string[]
  headDrawn: number
  dealerDrawnIndex: number
  flipStack: number
  flipSeat: number
  wallBreakIndex: number
}

/** 权威后端（引擎／worker）在局后交出的原始材料。 */
export interface EngineReproductionDump {
  /** 这份快照属于哪一局（引擎的 roundId）。调用方据此拒绝"错局的牌墙 + 本局的命令"。 */
  roundId: string
  opening: EngineOpeningSnapshot
  openingScores: readonly number[]
  dealer: number
  commands: readonly AnalysisCommandEntry[]
  dice?: { first?: readonly number[]; second?: readonly number[] }
}

/** 一局的赛后私有复现数据（下发形态；字段与 `AnalysisReproduction` 同口径，另加传输身份）。 */
export interface AnalysisReproductionPayload {
  formatVersion: number
  /** 与展示回放共用的场次 id：客户端据此确认"这是我这场的数据"。 */
  matchId: string
  roundIndex: number
  authorityEpoch: string
  roundId: string
  dealer: number
  initialWall: string[]
  initialHands: string[][]
  dealerDrawnIndex: number
  flipTiles: string[]
  jokers: string[]
  flipSeat: number
  wallBreakIndex: number
  flipStack: number
  openingScores: number[]
  commands: AnalysisCommandEntry[]
  dice?: { first?: number[]; second?: number[] }
}

const isTile = (value: unknown): value is string => typeof value === 'string' && (TILE_TYPES as readonly string[]).includes(value)
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const isSeat = (value: unknown): value is number => isInt(value) && value >= 0 && value < 4
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256

/**
 * 用权威引擎的开局快照与命令序列组装一局的复现载荷。
 *
 * 返回 null 表示**这一局拿不到复现数据**（引擎没开录制、开局快照不完整等）—— 调用方必须如实标记，
 * 而不是发一份缺字段的载荷让客户端"复现"出另一个局面。
 */
export function buildReproductionPayload(input: {
  dump: EngineReproductionDump
  matchId: string
  roundIndex: number
  authorityEpoch: string
  roundId: string
}): AnalysisReproductionPayload | null {
  const { dump, matchId, roundIndex, authorityEpoch, roundId } = input
  const opening = dump.opening
  if (!isText(matchId) || !isInt(roundIndex) || roundIndex < 1) return null
  if (!isText(authorityEpoch) || !isText(roundId) || !isSeat(dump.dealer)) return null
  // 错局防护：快照必须属于被请求的那一局。权威在读快照的同时可能已经推进到下一局，
  // 那时"下一局的牌墙 + 本局的命令"重跑出来是一个看似成功的错误结论（比失败更难发现）。
  if (dump.roundId !== roundId) return null
  if (!opening || !Array.isArray(opening.players) || opening.players.length !== SEATS.length) return null
  if (!Array.isArray(opening.wall) || !opening.wall.length || !opening.wall.every(isTile)) return null
  if (!Array.isArray(opening.flipTiles) || opening.flipTiles.length !== 2 || !opening.flipTiles.every(isTile)) return null
  if (!Array.isArray(opening.jokers) || !opening.jokers.length || !opening.jokers.every(isTile)) return null
  if (![opening.headDrawn, opening.dealerDrawnIndex, opening.flipStack, opening.flipSeat, opening.wallBreakIndex].every(isInt)) return null
  const hands = opening.players.map(player => [...(player?.hand ?? [])])
  if (hands.some(hand => !hand.length || hand.length > 14 || !hand.every(isTile))) return null
  const openingScores = [...(dump.openingScores ?? [])]
  if (openingScores.length !== SEATS.length || !openingScores.every(isInt)) return null
  const commands = [...(dump.commands ?? [])]
  // 权威命令序列是精确复现的必需项（§6）：空序列只可能意味着"引擎没开命令记录"，
  // 这时宁可**拿不到**（调用方如实标记），也不能给一份跑不动的"完整数据"。
  if (!commands.length || commands.length > ANALYSIS_REPRODUCTION_MAX_COMMANDS) return null
  const first = dump.dice?.first, second = dump.dice?.second
  return {
    formatVersion: ANALYSIS_REPRODUCTION_FORMAT_VERSION,
    matchId, roundIndex, authorityEpoch, roundId,
    dealer: dump.dealer,
    initialWall: [...opening.wall],
    initialHands: hands,
    dealerDrawnIndex: opening.dealerDrawnIndex,
    flipTiles: [...opening.flipTiles],
    jokers: [...opening.jokers],
    flipSeat: opening.flipSeat,
    wallBreakIndex: opening.wallBreakIndex,
    flipStack: opening.flipStack,
    openingScores,
    commands,
    ...(first || second ? { dice: { ...(first ? { first: [...first] } : {}), ...(second ? { second: [...second] } : {}) } } : {}),
  }
}

export interface ReproductionPayloadDecode {
  payload: AnalysisReproductionPayload | null
  /** 拒绝原因；null 表示成功。绝不返回"部分可用"的载荷。 */
  reason: string | null
}

/**
 * 校验并解码收到的复现载荷。
 *
 * 收到的对象可能来自任何 peer（坏包、旧版本、恶意构造），因此这里逐字段校验：
 * 版本、身份、牌名、长度、四家手牌、开局分数、命令规模。任何一项不过就整份拒绝 ——
 * 半份数据写进分析区，只会让赛后复现得出一个**看似成功**的错误结论。
 */
export function decodeReproductionPayload(value: unknown): ReproductionPayloadDecode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { payload: null, reason: '载荷不是对象' }
  const raw = value as Record<string, unknown>
  if (raw.formatVersion !== ANALYSIS_REPRODUCTION_FORMAT_VERSION) {
    return { payload: null, reason: `复现载荷格式版本不兼容：${String(raw.formatVersion)}` }
  }
  if (!isText(raw.matchId) || !isInt(raw.roundIndex) || raw.roundIndex < 1) return { payload: null, reason: '载荷缺少场次/局号' }
  if (!isText(raw.authorityEpoch) || !isText(raw.roundId) || !isSeat(raw.dealer)) return { payload: null, reason: '载荷缺少权威身份或庄家' }
  if (!Array.isArray(raw.initialWall) || !raw.initialWall.length || raw.initialWall.length > 134 || !raw.initialWall.every(isTile)) {
    return { payload: null, reason: '初始牌墙缺失或含未知牌' }
  }
  if (!Array.isArray(raw.initialHands) || raw.initialHands.length !== SEATS.length
    || !raw.initialHands.every(hand => Array.isArray(hand) && hand.length > 0 && hand.length <= 14 && hand.every(isTile))) {
    return { payload: null, reason: '初始手牌缺失或含未知牌' }
  }
  if (!Array.isArray(raw.flipTiles) || raw.flipTiles.length !== 2 || !raw.flipTiles.every(isTile)) return { payload: null, reason: '翻精不是两张已知牌' }
  if (!Array.isArray(raw.jokers) || !raw.jokers.length || !raw.jokers.every(isTile)) return { payload: null, reason: '精牌缺失或含未知牌' }
  if (![raw.dealerDrawnIndex, raw.flipSeat, raw.wallBreakIndex, raw.flipStack].every(isInt)) return { payload: null, reason: '开局参数缺失' }
  const drawnIndex = raw.dealerDrawnIndex as number
  const dealerHand = raw.initialHands[raw.dealer as number]
  if (drawnIndex < 0 || drawnIndex >= dealerHand.length) return { payload: null, reason: '庄家第 14 张下标越界' }
  if (!Array.isArray(raw.openingScores) || raw.openingScores.length !== SEATS.length || !raw.openingScores.every(isInt)) {
    return { payload: null, reason: '开局分数缺失（缺了它结束后无法比对）' }
  }
  if (!Array.isArray(raw.commands) || raw.commands.length > ANALYSIS_REPRODUCTION_MAX_COMMANDS) return { payload: null, reason: '命令序列缺失或规模异常' }
  const commands: AnalysisCommandEntry[] = []
  for (const entry of raw.commands as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return { payload: null, reason: '命令条目不是对象' }
    const command = entry as Record<string, unknown>
    // expire 条目用 seat=-1 表示"不是某个座位的决定"，其余必须是合法座位
    if (!isInt(command.seat) || (command.seat !== -1 && !isSeat(command.seat))) return { payload: null, reason: '命令条目座位非法' }
    if (typeof command.kind !== 'string' || !command.kind.length || command.kind.length > 32) return { payload: null, reason: '命令条目缺少 kind' }
    if (command.tile !== undefined && !isTile(command.tile)) return { payload: null, reason: '命令条目含未知牌' }
    if (command.tiles !== undefined && (!Array.isArray(command.tiles) || !command.tiles.every(isTile))) return { payload: null, reason: '命令条目组合含未知牌' }
    if (command.windowId !== undefined && !isText(command.windowId)) return { payload: null, reason: '命令条目窗口 id 非法' }
    if (command.resolution !== undefined && !['command', 'auto', 'expire'].includes(String(command.resolution))) {
      return { payload: null, reason: '命令条目推进来源非法' }
    }
    commands.push(command as unknown as AnalysisCommandEntry)
  }
  const encoded = utf8Bytes(JSON.stringify(value))
  if (encoded > ANALYSIS_REPRODUCTION_MAX_BYTES) return { payload: null, reason: '复现载荷超过单局上限' }
  return {
    payload: {
      formatVersion: ANALYSIS_REPRODUCTION_FORMAT_VERSION,
      matchId: raw.matchId, roundIndex: raw.roundIndex as number,
      authorityEpoch: raw.authorityEpoch, roundId: raw.roundId, dealer: raw.dealer as number,
      initialWall: [...(raw.initialWall as string[])],
      initialHands: (raw.initialHands as string[][]).map(hand => [...hand]),
      dealerDrawnIndex: drawnIndex,
      flipTiles: [...(raw.flipTiles as string[])],
      jokers: [...(raw.jokers as string[])],
      flipSeat: raw.flipSeat as number,
      wallBreakIndex: raw.wallBreakIndex as number,
      flipStack: raw.flipStack as number,
      openingScores: [...(raw.openingScores as number[])],
      commands,
      ...(raw.dice && typeof raw.dice === 'object' ? { dice: structuredClone(raw.dice) as AnalysisReproductionPayload['dice'] } : {}),
    },
    reason: null,
  }
}

/**
 * 载荷 → 分析区的 `reproduction` 记录。
 * 带 `origin: 'authority'`：赛后读记录的人必须能分清"这是本机引擎给的"还是"联机权威端给的"（§6、§9.5）。
 */
export function reproductionFromPayload(payload: AnalysisReproductionPayload): AnalysisReproduction {
  return {
    roundIndex: payload.roundIndex,
    available: true,
    origin: 'authority',
    initialWall: [...payload.initialWall],
    initialHands: payload.initialHands.map(hand => [...hand]),
    dealerDrawnIndex: payload.dealerDrawnIndex,
    flipTiles: [...payload.flipTiles],
    jokers: [...payload.jokers],
    flipSeat: payload.flipSeat,
    wallBreakIndex: payload.wallBreakIndex,
    dealer: payload.dealer,
    openingScores: [...payload.openingScores],
    ...(payload.flipTiles[0] ? { flipTile: payload.flipTiles[0] } : {}),
    flipStack: payload.flipStack,
    commands: payload.commands.map(entry => ({ ...entry })),
    ...(payload.dice ? { dice: structuredClone(payload.dice) } : {}),
  }
}

/**
 * 拿不到赛后私有数据时的记录：**如实标成不可用并给出原因**（§6："无法提供时明确标记复现能力不足，
 * 不猜测补齐"）。写入它比什么都不写更重要 —— 否则赛后看到的只是一片空白，无从判断是"没录到"还是"没这功能"。
 */
export function unavailableReproduction(roundIndex: number, reason: string): AnalysisReproduction {
  return { roundIndex, available: false, unavailableReason: reason }
}
