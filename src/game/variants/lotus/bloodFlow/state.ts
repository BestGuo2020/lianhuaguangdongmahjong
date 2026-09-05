import type { GamePlayer, TileType } from '../../../core/contracts/types'
import type { BloodFlowSeatState, Seat, SeatVector, SourceTileEvent } from './types'

export const SEATS: readonly Seat[] = [0, 1, 2, 3]
export const vector = <T>(create: (seat: Seat) => T): [T, T, T, T] => [create(0), create(1), create(2), create(3)]
export const nextSeat = (seat: Seat): Seat => ((seat + 1) % 4) as Seat
export const newSeatStates = () => vector<BloodFlowSeatState>(() => ({ winCount: 0, locked: false, firstWinSequence: null, recordIds: [] }))

export type BloodFlowAction =
  | { kind: 'win' } | { kind: 'pass' }
  | { kind: 'discard'; index: number }
  | { kind: 'concealed-kong'; tile: TileType }
  | { kind: 'added-kong'; meldIndex: number }
  | { kind: 'wind-kong' } | { kind: 'peng' } | { kind: 'gang' }
  | { kind: 'chi'; tiles: TileType[] }

export interface EngineCommand {
  authorityEpoch: string
  roundId: string
  windowId: string
  stateVersion: number
  seat: Seat
  action: BloodFlowAction
}

/** Authority input from the existing two-dice opening, also usable by fixed-wall tests. */
export interface BloodFlowOpeningState {
  players: GamePlayer[]
  wall: TileType[]
  flipTiles: [TileType, TileType]
  jokers: TileType[]
  headDrawn: number
  dealerDrawnIndex: number
  flipStack: number
  flipSeat: number
  wallBreakIndex: number
}

export interface EngineWindow {
  id: string
  version: number
  kind: 'turn' | 'win' | 'meld'
  source: SourceTileEvent
  deadlineAt: number
  options: SeatVector<readonly BloodFlowAction[]>
  decisions: [BloodFlowAction | null, BloodFlowAction | null, BloodFlowAction | null, BloodFlowAction | null]
}
