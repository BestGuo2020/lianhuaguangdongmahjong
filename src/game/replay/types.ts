// 对局回放的数据模型：只存本地（IndexedDB），不上服务器。
//
// 设计要点：录制「事件流 + 每步变化者的真实手牌/副露」，回放端只做纯覆盖折叠，
// 不重跑规则引擎 —— 规则/癞子判定不会与当时的对局漂移。
import type { RoundResult } from '../core/contracts/gamePort'
import type { GamePlayer, MatchType, Meld, TableActionType, TileType } from '../core/contracts/types'
import type { RuleVariant } from '../core/rules/ruleVariants'
import type { TableThemeName } from '../../theme/themeIdentity'

/** 结构版本：字段不兼容变更时递增，旧记录按版本丢弃。 */
export const REPLAY_SCHEMA_VERSION = 1
/** 本地保留上限（场），超出按开始时间淘汰最旧。 */
export const REPLAY_MAX_MATCHES = 50

export interface ReplayPlayer {
  seat: number
  name: string
  avatar: string
  characterId?: string
  playerKind?: 'human' | 'llm' | 'bot'
  isLlm?: boolean
  /** 本场起始分（回放锚点前的分数）。 */
  startScore: number
}

export type ReplayStepKind = 'draw' | 'discard' | 'meld' | 'win'

export type ReplayMeldKind =
  | 'peng' | 'chi'
  | 'gang-discard' | 'gang-concealed' | 'gang-added' | 'gang-flower' | 'gang-wind'

/** 某座位在某个动作之后的真实状态（只存发生变化的座位）。 */
export interface ReplaySeatState {
  hand: TileType[]
  melds: Meld[]
  drawnTileIndex: number
  redCount: number
  /** 仅当动作移除了牌河里的牌（碰/吃/杠）时才是权威值。 */
  discards?: TileType[]
}

export interface ReplayStep {
  t: ReplayStepKind
  /** 动作发起者（绝对座位）。 */
  seat: number
  tile?: TileType
  kind?: ReplayMeldKind
  /** 被吃/碰/杠的弃牌来源座位；自摸为 null。 */
  from?: number | null
  /** 桌动作类型（回放里复现鸣牌/胡牌提示字）。 */
  actionType?: TableActionType
  meldIndex?: number
  /** 摸牌来源：true = 杠后从牌尾补牌。 */
  fromTail?: boolean
  // ── 公共帧：3D 牌桌直接消费 ──
  wallLeft: number
  headDrawn: number
  currentPlayer: number
  lastDiscardId?: number
  // ── 变化者的真实值 ──
  state?: ReplaySeatState
  /** 被鸣牌带走弃牌的座位，其牌河在动作后的真实值。 */
  sourceDiscards?: TileType[]
  /** 仅在分数发生变化（杠 / 胡 / 跟庄）时记录。 */
  scores?: number[]
}

export interface ReplayAnchor {
  hands: TileType[][]
  melds: Meld[][]
  discards: TileType[][]
  drawnTileIndex: number[]
  redCount: number[]
  scores: number[]
  wallLeft: number
  headDrawn: number
  currentPlayer: number
}

export interface ReplayRoundFinal {
  hands: TileType[][]
  melds: Meld[][]
  discards: TileType[][]
  drawnTileIndex: number[]
  redCount: number[]
  scores: number[]
  draw: boolean
  winSeat?: number
  winTile?: TileType
  winType?: RoundResult['winType']
  horses?: TileType[]
  details?: RoundResult['details']
  totalMultiplier?: number
  points?: number
  /** 结算窗口展示所需的原始结果（番型标题、倍数、分数变化）。 */
  result?: RoundResult
}

export interface ReplayRound {
  id: string
  matchId: string
  /** 场次内第几局（1 起，连庄也算新的一局）。 */
  roundIndex: number
  /** 牌局序号（1..8，连庄时不变，用于牌风标签）。 */
  round: number
  roundLabel: string
  dealer: number
  honba: number
  matchType: MatchType
  dice: { first?: number[]; second?: number[] }
  diceThrowerIndex: number
  flipTile: TileType | null
  jokerTiles: TileType[]
  wildcardTiles: TileType[]
  wallBreakIndex: number
  flipStack: number | null
  /** 本局开始前的四家分数。 */
  scoresBefore: number[]
  anchor: ReplayAnchor
  steps: ReplayStep[]
  final: ReplayRoundFinal | null
  /** 落库时间；未落库（对局进行中）为 0。 */
  landedAt: number
}

export interface ReplayStanding {
  seat: number
  name: string
  score: number
  rank: number
}

export interface ReplayMatch {
  id: string
  schemaVersion: number
  rulesetId: RuleVariant
  /** 落库时的玩法文案快照（防后续改名）。 */
  rulesetName: string
  matchType: MatchType
  /** 「东风场」/「半庄场」。 */
  matchName: string
  /** local = 本机单机对局；remote = 联机对局（牌谱由房主生成后下发，全知）。 */
  gameMode: 'local' | 'remote'
  themeName: TableThemeName
  players: ReplayPlayer[]
  humanSeat: number
  startedAt: number
  endedAt: number
  status: 'finished' | 'aborted'
  roundCount: number
  /** 位次（仅 finished 有）。 */
  myRank?: number
  myScore?: number
  finalStandings?: ReplayStanding[]
  summary: string
  /**
   * 本场录制时是否开着分析录制（§9.2、§10.7）。
   * 旧记录没有这个字段（undefined）：列表据此标「缺少决策分析记录」而不是「未开启」。
   */
  analysisRecorded?: boolean
}

/**
 * 引擎在录制点交给录制器的只读局面快照。
 * 各引擎按自身能力填字段（莲花麻将多翻精/精牌，血流留待后续接入）。
 */
export interface ReplayFrameSource {
  players: GamePlayer[]
  wallLeft: number
  headDrawn: number
  currentPlayer: number
  round: number
  dealer: number
  honba: number
  matchType: MatchType
  diceValues: number[]
  /** 莲花麻将第一次掷骰（定翻精方位）；广麻不填。 */
  firstDice?: number[]
  diceThrowerIndex: number
  wallBreakIndex?: number
  flipTile?: TileType | null
  jokerTiles?: TileType[]
  wildcardTiles?: TileType[]
  flipStack?: number | null
}

/** 引擎侧需要回调的录制接口；useGame / lotusGame / 血流按需调用。 */
export interface ReplayRecorderHooks {
  roundStart(frame: ReplayFrameSource): void
  draw(event: { seat: number; tile: TileType; fromTail: boolean }, frame: ReplayFrameSource): void
  discard(event: { seat: number; tile: TileType; id: number }, frame: ReplayFrameSource): void
  tableAction(
    event: {
      type: TableActionType
      actorIndex: number
      sourceIndex: number | null
      tile: TileType
      meldIndex: number
    },
    frame: ReplayFrameSource,
  ): void
  roundEnd(result: RoundResult, frame: ReplayFrameSource): void
}
