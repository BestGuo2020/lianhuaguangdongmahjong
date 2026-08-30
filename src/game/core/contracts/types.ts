export type Suit = 'm' | 'p' | 's'
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export type SuitedTile = `${Suit}${Rank}`
export type HonorTile = 'east' | 'south' | 'west' | 'north' | 'red' | 'green' | 'white'
export type TileType = SuitedTile | HonorTile
export type MatchType = 'east' | 'hanchan'

export interface Meld {
  type: 'peng' | 'gang' | 'angang' | 'flower' | 'chi'
  tile: TileType
  tiles: TileType[]
  from?: number
  added?: boolean
  pending?: boolean
  /** 风杠（乱风杠）：东南西北各 1 张组成的亮明暗杠 */
  windKong?: boolean
}

export interface GamePlayer {
  name: string
  avatar: string
  /** 联机服务端大模型座位；用于屏蔽重复的原始动作音效。 */
  isLlm?: boolean
  /** llmAnime 表现角色；协议/存储中的未知值必须经角色白名单解析。 */
  characterId?: string
  /** 玩家身份只用于表现与声音策略，不参与规则判定。 */
  playerKind?: 'human' | 'llm' | 'bot'
  score: number
  seat: number
  hand: TileType[]
  /** Concealed tile count when a remote player's faces are intentionally hidden. */
  concealedTileCount?: number
  discards: TileType[]
  melds: Meld[]
  redCount: number
  drawnTileIndex: number
}

export type TableActionType =
  | 'peng'
  | 'chi'
  | 'discard-gang'
  | 'concealed-gang'
  | 'added-gang'
  | 'flower-gang'
  | 'wind-kong'
  | 'self-draw'
  | 'discard-win'
  | 'robbed-kong-win'

export interface TableActionEvent {
  id: number
  type: TableActionType
  actorIndex: number
  sourceIndex: number | null
  tile: TileType
  meldIndex: number
}

export interface ScoreDelta {
  playerIndex: number
  amount: number
}

export interface ScoreFlowEvent {
  id: number
  deltas: ScoreDelta[]
}

export interface WinPresentation {
  winnerIndex: number
  tile: TileType
  sourceIndex: number
  robbedKong: boolean
  /** 点炮牌来自牌河，直接进入胡牌展示区，不属于赢家普通手牌。 */
  discardWin?: boolean
  robbedKongPlayerIndex: number
  robbedKongMeldIndex: number
}

export interface EndGameOptions {
  winTile?: TileType
  /** 点炮胡的弃牌来源座位；自摸/抢杠胡不设置。 */
  sourceFrom?: number
  fourRed?: boolean
  kongBloom?: boolean
  robbedKong?: boolean
  robbedKongPlayerIndex?: number
}
