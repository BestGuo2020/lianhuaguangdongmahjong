import type { Announcement, GamePhase, LastDiscard, RoundResult } from '../../core/contracts/gamePort'
import type { GamePlayer, MatchType, Meld, TileType, WinPresentation } from '../../core/contracts/types'
import type { RuleVariant } from '../../core/rules/ruleVariants'

export interface ServerMeldDto extends Omit<Meld, 'from' | 'added' | 'pending'> {
  from?: number | null
  added?: boolean | null
  pending?: boolean | null
  windKong?: boolean | null
}

export interface ServerPlayerDto extends Omit<GamePlayer, 'hand' | 'concealedTileCount' | 'melds'> {
  /** null represents an intentionally hidden tile face. */
  hand: Array<TileType | null>
  melds: ServerMeldDto[]
}

export interface ServerSnapshot {
  kind: 'state_snapshot'
  roomId: string
  mode: MatchType
  rulesetId?: RuleVariant
  phase: GamePhase
  round: number
  dealer: number
  honba: number
  dice?: [number, number]
  secondDice?: [number, number]
  flipTile?: TileType | null
  jokerTiles?: TileType[]
  wildcardTiles?: TileType[]
  flipStack?: number | null
  openingStack?: number | null
  wallBreakIndex?: number
  wallCount: number
  /** Remote snapshots may omit the remaining wall to prevent future-draw leakage. */
  wall?: TileType[]
  headDrawn: number
  currentPlayer: number
  players: ServerPlayerDto[]
  seat: number
  result: RoundResult | null
  /** 服务端局末 LLM 发言尚未结束；客户端可先播胡牌演出，结算面板等完成消息。 */
  roundSpeechPending?: boolean
  announcement: Announcement | null
  matchFinished: boolean
  lastDiscard: LastDiscard | null
  winPresentation: WinPresentation | null
  winningPlayerIndex: number
}

export type LocalSnapshot = Omit<ServerSnapshot, 'players'> & { players: GamePlayer[] }
