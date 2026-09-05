import type { MatchType, Meld, TileType } from '../../../core/contracts/types'
import type {
  ExcludedPattern, PatternDefinition, PatternId, ScoringItem, WinningDecomposition,
} from '../patterns/types'

export type Seat = 0 | 1 | 2 | 3
export type SeatVector<T> = readonly [T, T, T, T]
export type WinSource = 'discard' | 'self-draw' | 'robbed-kong' | 'kong-bloom'
export type BloodFlowRuleVersion = 'lotus-blood-flow-v1'

export interface BloodFlowRuleConfig {
  readonly id: 'lotus-blood-flow'
  readonly version: BloodFlowRuleVersion
  readonly label: string
  readonly basePoints: number
  readonly initialScore: number
  readonly maxMultiplierPerPayer: number
  readonly hardWinMultiplier: number
  readonly patterns: Readonly<Record<PatternId, PatternDefinition>>
  readonly eventMultipliers: Readonly<Record<WinSource, number>>
  readonly openingMinimumMultiplier: number
  readonly kongPayments: Readonly<Record<'discard' | 'added' | 'concealed' | 'wind', number>>
  readonly rounds: Readonly<Record<MatchType, number>>
  readonly lockAfterFirstWin: true
  readonly multipleWinners: true
  readonly allowNegativeScores: true
  readonly alreadyWonPlayersPay: true
  readonly dealerMultiplier: 1
  readonly dealerRotation: 'every-round'
  readonly crossWindowPassRestriction: false
  readonly extraPayments: readonly []
}

/** concealed EXCLUDES the winning tile for every source, including self-draw/tianhu.
 * Only winningTile loses its wildcard ability on an external win. Existing jokers do not.
 * Contains this seat's hand only; not an AI prompt or a public protocol payload.
 */
export interface WinEvaluationInput {
  readonly concealed: readonly TileType[]
  readonly melds: readonly Readonly<Meld>[]
  readonly winningTile: TileType
  readonly source: WinSource
  readonly jokers: readonly TileType[]
  readonly opening: 'heaven' | 'earth' | null
}

export interface PublicWinScore {
  readonly items: readonly ScoringItem[]
  readonly excluded: readonly ExcludedPattern[]
  readonly hardWin: boolean
  readonly source: WinSource
  readonly opening: 'heaven' | 'earth' | null
  readonly patternMultiplier: number
  readonly eventMultiplier: number
  readonly openingApplied: boolean
  readonly uncappedMultiplier: number
  readonly finalMultiplier: number
  readonly capped: boolean
  readonly paymentPerPayer: number
}

/** Private result; public transports must explicitly project .score, never spread this. */
export interface WinEvaluation {
  readonly ruleVersion: BloodFlowRuleVersion
  readonly decomposition: WinningDecomposition
  readonly naturalEvidence: { readonly allAssignmentsIdentity: boolean }
  readonly score: PublicWinScore
}

/** Stable authority identity; source IDs never change when the viewer rotates seats. */
export interface BloodFlowEventIdentity {
  readonly authorityEpoch: string
  readonly sequence: number
  readonly roundId: string
}

export interface SourceTileEvent {
  readonly id: string
  readonly tile: TileType
  readonly seat: Seat
  readonly kind: 'draw' | 'discard' | 'added-kong'
}

export interface ClaimWindow extends BloodFlowEventIdentity {
  readonly windowId: string
  readonly stateVersion: number
  readonly source: SourceTileEvent
  readonly candidates: readonly Seat[]
  readonly decisions: SeatVector<'win' | 'pass' | null>
  readonly deadlineAt: number
  readonly status: 'open' | 'committed' | 'cancelled'
}

export interface BloodFlowClaimCommand {
  readonly authorityEpoch: string
  readonly roundId: string
  readonly windowId: string
  readonly stateVersion: number
  readonly requestId: string
  readonly seat: Seat
  readonly decision: 'win' | 'pass'
}

/** Public reference only: a three-winner batch still archives one source tile. */
export interface WinRecord {
  readonly id: string
  readonly batchId: string
  readonly winner: Seat
  readonly ordinal: number
  readonly sourceEventId: string
  readonly score: PublicWinScore
  readonly deltas: SeatVector<number>
}

export type BloodFlowNextAction =
  | { readonly kind: 'draw'; readonly seat: Seat }
  | { readonly kind: 'finish-round'; readonly reason: 'wall-exhausted' }

export interface WinBatch extends BloodFlowEventIdentity {
  readonly ruleVersion: BloodFlowRuleVersion
  readonly batchId: string
  readonly windowId: string
  readonly source: SourceTileEvent
  readonly winners: readonly WinRecord[]
  readonly deltas: SeatVector<number>
  readonly scoresAfter: SeatVector<number>
  readonly nextAction: BloodFlowNextAction
}

export interface BloodFlowSeatState {
  readonly winCount: number
  readonly locked: boolean
  readonly firstWinSequence: number | null
  readonly recordIds: readonly string[]
}

export interface KongLedgerEntry extends BloodFlowEventIdentity {
  readonly kind: 'kong'
  readonly id: string
  readonly actor: Seat
  readonly kongKind: 'discard' | 'added' | 'concealed' | 'wind'
  readonly sourceSeat: Seat | null
  readonly deltas: SeatVector<number>
  readonly scoresAfter: SeatVector<number>
}

export type BloodFlowLedgerEntry = KongLedgerEntry | {
  readonly kind: 'win'
  readonly batch: WinBatch
}

export interface BloodFlowRoundResult {
  readonly ruleVersion: BloodFlowRuleVersion
  readonly roundId: string
  readonly reason: 'wall-exhausted'
  readonly openingScores: SeatVector<number>
  readonly endingScores: SeatVector<number>
  readonly winNet: SeatVector<number>
  readonly kongNet: SeatVector<number>
  readonly winCounts: SeatVector<number>
  readonly ranks: SeatVector<number>
  readonly ledger: readonly BloodFlowLedgerEntry[]
}

/** Public optional port capability. Interruption cannot masquerade as a settled round. */
export interface BloodFlowPublicState {
  readonly ruleVersion: BloodFlowRuleVersion
  readonly roundId: string
  readonly status: 'playing' | 'paused' | 'interrupted' | 'settled'
  readonly seats: SeatVector<BloodFlowSeatState>
  readonly batches: readonly WinBatch[]
  readonly roundResult: BloodFlowRoundResult | null
}

export interface BloodFlowTableState extends BloodFlowPublicState {
  readonly continuation?: { readonly ready:boolean; readonly readySeats:readonly Seat[]; readonly requiredSeats:readonly Seat[] }
  readonly presentationKey?: string
  readonly roundBubbles?: Record<number, { text: string; id: number; persistent?: boolean }>
  readonly preview: PublicWinScore | null
  readonly waits: readonly { tile: TileType; selfDraw: PublicWinScore | null; discard: PublicWinScore | null }[]
}
