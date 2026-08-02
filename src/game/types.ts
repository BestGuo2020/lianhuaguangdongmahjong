export type Suit = 'm' | 'p' | 's'
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export type SuitedTile = `${Suit}${Rank}`
export type HonorTile = 'east' | 'south' | 'west' | 'north' | 'red' | 'green' | 'white'
export type TileType = SuitedTile | HonorTile
export type MatchType = 'east' | 'hanchan'

export interface Meld {
  type: 'peng' | 'gang' | 'angang' | 'flower'
  tile: TileType
  tiles: TileType[]
  from?: number
  added?: boolean
  pending?: boolean
}

export interface GamePlayer {
  name: string
  avatar: string
  score: number
  seat: number
  hand: TileType[]
  discards: TileType[]
  melds: Meld[]
  redCount: number
  drawnTileIndex: number
}

export type TableActionType =
  | 'peng'
  | 'discard-gang'
  | 'concealed-gang'
  | 'added-gang'
  | 'flower-gang'
  | 'self-draw'
  | 'robbed-kong-win'

export interface TableActionEvent {
  id: number
  type: TableActionType
  actorIndex: number
  sourceIndex: number | null
  tile: TileType
  meldIndex: number
}

export interface WinPresentation {
  winnerIndex: number
  tile: TileType
  sourceIndex: number
  robbedKong: boolean
  robbedKongPlayerIndex: number
  robbedKongMeldIndex: number
}

export interface EndGameOptions {
  winTile?: TileType
  fourRed?: boolean
  robbedKong?: boolean
  robbedKongPlayerIndex?: number
}
