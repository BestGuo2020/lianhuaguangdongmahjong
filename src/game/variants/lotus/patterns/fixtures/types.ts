import type { WinEvaluationInput, WinSource } from '../../bloodFlow/types'
import type { HandShape, PatternId } from '../types'

export interface GoldenWinCase {
  readonly id: string
  readonly input: WinEvaluationInput
  readonly expected: {
    readonly winning: boolean
    readonly includes?: readonly PatternId[]
    readonly excludes?: readonly PatternId[]
    readonly shape?: HandShape
    readonly hardWin?: boolean
    readonly paymentPerPayer?: number
  }
}

/** Independent arithmetic oracles, applied per decomposition before choosing a winner. */
export interface GoldenScoreCase {
  readonly id: string
  readonly candidates: readonly {
    readonly patterns: readonly PatternId[]
    readonly natural: boolean
    readonly source: WinSource
    readonly opening: boolean
  }[]
  readonly expected: {
    readonly candidateIndex: number
    readonly finalMultiplier: number
    readonly paymentPerPayer: number
    readonly totalWon: number
  }
}
