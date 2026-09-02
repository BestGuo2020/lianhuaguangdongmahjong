import type {
  GamePlayer,
  MatchType,
  ScoreFlowEvent,
  TableActionEvent,
  TileType,
  WinPresentation,
} from './types'

export interface RefLike<T> {
  value: T
}

export interface LastDiscard {
  tile: TileType
  from: number
  id: number
}

export interface Announcement {
  text: string
  tone: string
  id: number
}

/** 吃（chi）候选项：一组可吃的具体面子（含被弃的牌）。 */
export interface ChiOption {
  tiles: TileType[]
  kind: 'sequence' | 'wind' | 'dragon'
}

/** UI prompt shared by local and remote player-action controllers. */
export interface ActionPrompt {
  type: string
  tile: TileType
  from: number
  canGang?: boolean
  canPeng?: boolean
  canHu?: boolean
  remainingClaims?: Array<{ playerIndex: number; canGang: boolean }>
  /** 莲花麻将「吃」候选项（弃牌的下家可吃）。 */
  chiOptions?: ChiOption[]
}

export type GamePhase =
  | 'lobby' | 'dealing' | 'opening' | 'playing'
  | 'drawing' | 'thinking' | 'checking' | 'discard' | 'prompt' | 'kong'
  | 'win-effect' | 'revealing' | 'settled' | 'finished'

export type OpeningStage = 'start' | 'dice' | 'flip' | 'deal'

export interface DealAnimation {
  playerIndex: number
  count: number
  serial: number
}

export interface RoundScoreDetail {
  label: string
  multiplier?: number
  points?: number
}

export interface RoundScoreChange {
  playerIndex: number
  name: string
  avatar: string
  characterId?: string
  playerKind?: 'human' | 'llm' | 'bot'
  isLlm?: boolean
  fallbackAvatar?: string
  score: number
  delta: number
  rank?: number
}

export interface RoundResult {
  draw?: boolean
  winnerIndex?: number
  winner?: string
  roundLabel?: string
  honba?: number
  horses?: TileType[]
  hits?: number
  multiplier?: number
  totalMultiplier?: number
  horsePoints?: number
  points?: number
  totalWon?: number
  details?: RoundScoreDetail[]
  scoreChanges?: RoundScoreChange[]
  tenpai?: number[]
  dealerTenpai?: boolean
  fourRed?: boolean
  kongBloom?: boolean
  robbedKong?: boolean
  robbedKongPlayerIndex?: number
  winTile?: TileType
  /** 莲花麻将胡牌类型（自摸/点炮/抢杠/天胡/地胡），供结算标题展示。 */
  winType?: 'self-draw' | 'discard' | 'robbed-kong' | 'tianhu' | 'dihu'
}

export interface WinEffect {
  winnerIndex: number
  tile: TileType
  robbedKong: boolean
  robbedKongPlayerIndex: number
  robbedKongMeldIndex: number
  duration: number
  reducedMotion: boolean
  id: number
}

export interface WaitTileInfo {
  tile: TileType
  remaining: number
}

export interface WaitInfo {
  discard: TileType | null
  tiles: WaitTileInfo[]
  any: boolean
  remaining: number
}

export interface GameCapabilities {
  chi?: { choose(optionIndex: number): void }
  windKong?: { available: boolean; execute(): void }
  lotusTable?: {
    flipTile: TileType | null
    jokerTiles: TileType[]
    wildcardTiles: TileType[]
    wallBreakIndex: number
    flipStack: number | null
  }
}

export interface GamePort {
  phase: RefLike<GamePhase>
  players: GamePlayer[]
  wall: RefLike<TileType[]>
  wallHeadDrawn: RefLike<number>
  wallCount: RefLike<number>
  currentPlayer: RefLike<number>
  selectedIndex: RefLike<number>
  turnSeconds: RefLike<number>
  lastDiscard: RefLike<LastDiscard | null>
  actionPrompt: RefLike<ActionPrompt | null>
  announcement: RefLike<Announcement | null>
  tableActionEvent: RefLike<TableActionEvent | null>
  scoreFlowEvent: RefLike<ScoreFlowEvent | null>
  result: RefLike<RoundResult | null>
  winEffect: RefLike<WinEffect | null>
  winPresentation: RefLike<WinPresentation | null>
  revealHands: RefLike<boolean>
  winningPlayerIndex: RefLike<number>
  round: RefLike<number>
  dealer: RefLike<number>
  user: RefLike<GamePlayer | undefined>
  isUserTurn: RefLike<boolean>
  userCanHu: RefLike<boolean>
  matchType: RefLike<MatchType>
  matchName: RefLike<string>
  matchFinished: RefLike<boolean>
  honba: RefLike<number>
  roundLabel: RefLike<string>
  standings: RefLike<Array<GamePlayer & { playerIndex: number; rank: number }>>
  dealAnimation: RefLike<DealAnimation>
  openingStage: RefLike<OpeningStage | null>
  diceValues: RefLike<number[]>
  /** 当前开局骰子的投掷者。 */
  diceThrowerIndex: RefLike<number>
  userCurrentWaits: RefLike<WaitInfo | null>
  userTingOptions: RefLike<WaitInfo[]>
  userDiscardWaits: RefLike<WaitInfo | null>
  userKongs: RefLike<TileType[]>
  /** 莲花麻将：手牌同时持有东南西北各 1 张可暗杠（乱风杠）。 */
  capabilities: RefLike<GameCapabilities>

  startGame(mode?: MatchType, options?: GameStartOptions): unknown
  selectTile(index: number): void
  clearUserSelection(): void
  userDiscard(index?: number): void
  userPass(): void
  userPeng(): void
  userGangFromDiscard(): void
  userGang(tile?: TileType): void
  userHu(): void
  /** 莲花麻将：从吃候选中选择第 chiIndex 组吃面子（现行玩法为 no-op）。 */
  /** 莲花麻将：暗杠（乱风杠）东南西北各 1 张（现行玩法为 no-op）。 */
  nextRound(options?: GameStartOptions): void
  returnToLobby(): void
  tileName(tile: TileType): string
}

export interface GameStartOptions {
  /** 牌桌 3D 场景就绪前暂停开局时间线。 */
  waitForTableReady?: () => Promise<void>
  /** 联机承诺洗牌产出的牌墙；莲花麻将这里表示尚未翻精前的环序牌墙。 */
  initialWall?: TileType[]
  /** 广麻的一骰；莲花麻将的第一次骰点。 */
  openingDice?: [number, number]
  /** 莲花麻将的第二次骰点。 */
  openingSecondDice?: [number, number]
}

type FunctionKeys<T> = {
  [K in keyof T]-?: T[K] extends (...args: any[]) => any ? K : never
}[keyof T]

type GamePortActionKey = FunctionKeys<GamePort>
type GamePortStateKey = Exclude<keyof GamePort, GamePortActionKey>

export const GAME_PORT_STATE_KEYS = [
  'phase', 'players', 'wall', 'wallHeadDrawn', 'wallCount', 'currentPlayer', 'selectedIndex',
  'turnSeconds', 'lastDiscard', 'actionPrompt', 'announcement', 'tableActionEvent',
  'scoreFlowEvent', 'result', 'winEffect', 'winPresentation', 'revealHands',
  'winningPlayerIndex', 'round', 'dealer', 'user', 'isUserTurn', 'userCanHu', 'matchType',
  'matchName', 'matchFinished', 'honba', 'roundLabel', 'standings', 'dealAnimation',
  'openingStage', 'diceValues', 'diceThrowerIndex', 'userCurrentWaits', 'userTingOptions', 'userDiscardWaits',
  'userKongs', 'capabilities',
] as const satisfies ReadonlyArray<GamePortStateKey>

export const GAME_PORT_ACTION_KEYS = [
  'startGame', 'selectTile', 'clearUserSelection', 'userDiscard', 'userPass', 'userPeng',
  'userGangFromDiscard', 'userGang', 'userHu',
  'nextRound', 'returnToLobby', 'tileName',
] as const satisfies ReadonlyArray<GamePortActionKey>

type MissingStateKeys = Exclude<GamePortStateKey, typeof GAME_PORT_STATE_KEYS[number]>
type MissingActionKeys = Exclude<GamePortActionKey, typeof GAME_PORT_ACTION_KEYS[number]>

// 新增契约字段却忘记补测试清单时，这两个断言会让类型检查失败。
const allStateKeysCovered: MissingStateKeys extends never ? true : never = true
const allActionKeysCovered: MissingActionKeys extends never ? true : never = true
void allStateKeysCovered
void allActionKeysCovered

/**
 * 编译期契约检查，同时保留实现自身的精确返回类型和扩展能力。
 */
export function defineGamePort<T>(port: T & GamePort): T & GamePort {
  return port
}
