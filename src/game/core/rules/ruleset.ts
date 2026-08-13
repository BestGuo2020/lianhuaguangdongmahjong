import type { GamePlayer, Meld, ScoreDelta, TileType } from '../contracts/types'
import { CLASSIC_RULESET } from './rules'

export interface RuleEvaluationContext {
  /** Variant-specific wild tiles. The classic ruleset ignores this value. */
  jokers?: readonly TileType[]
  /** Physical tiles that may substitute for the configured jokers; they are not joker tiles themselves. */
  jokerSubstitutes?: readonly TileType[]
  /** Tiles that must be evaluated by face value instead of as wild tiles. */
  ordinaryJokers?: readonly TileType[]
}

export interface ScoreHandOptions {
  dealer?: boolean
  noJoker?: boolean
  fourRed?: boolean
  kongBloom?: boolean
  horseHits?: number
  robbedKong?: boolean
}

export interface ScoreHandDetail {
  label: string
  multiplier?: number
  points?: number
}

export interface ScoreHandResult {
  multiplier: number
  totalMultiplier: number
  horsePoints: number
  points: number
  details: ScoreHandDetail[]
}

export interface FanPattern {
  label: string
  multiplier?: number
  points?: number
}

export interface WinSettlement {
  H: number
  dealerPays: number
  nonDealerPays: number
  total: number
}

export interface WinScoreFlags {
  dealer: boolean
  selfDraw: boolean
  robbedKong: boolean
  kongBloom: boolean
  tianhu: boolean
  dihu: boolean
}

export interface FanResult {
  fan: number
  baseFan: number
  patterns: FanPattern[]
  settlement: WinSettlement
}

export interface FanRules {
  scoreFan(
    tiles: TileType[],
    exposedMeldCount: number,
    flags: WinScoreFlags,
    context?: RuleEvaluationContext,
  ): FanResult | null
}

export type KongType = 'discard' | 'concealed' | 'added'

export interface WinFlowConfig {
  /** Current game behavior is one winner per round. */
  mode: 'single-win' | 'blood-battle' | 'blood-flow'
  /** Future modes can continue the round after a player wins. */
  continueAfterWin: boolean
  /** Future modes can settle more than one winner from the same discard. */
  allowMultipleWinners: boolean
}

export interface RuleSet {
  readonly id: string
  readonly baseScore: number
  readonly flow: WinFlowConfig
  readonly win: {
    isWinningHand(
      tiles: TileType[],
      exposedMeldCount?: number,
      context?: RuleEvaluationContext,
    ): boolean
    waitingTiles(
      tiles: TileType[],
      exposedMeldCount?: number,
      context?: RuleEvaluationContext,
    ): TileType[]
    canRobKong(
      tiles: TileType[],
      kongTile: TileType,
      exposedMeldCount?: number,
      context?: RuleEvaluationContext,
    ): boolean
    concealedKongs(tiles: TileType[], context?: RuleEvaluationContext): TileType[]
    /** Optional base-pattern evaluation for rulesets that expose fan details. */
    evaluatePattern?(
      tiles: TileType[],
      exposedMeldCount: number,
      context?: RuleEvaluationContext,
    ): { pattern: string; fan: number } | null
  }
  readonly fan?: FanRules
  readonly score: {
    scoreHand(options: ScoreHandOptions): ScoreHandResult
    applyKongScore(
      players: GamePlayer[],
      kongPlayerIndex: number,
      type: KongType,
      fromIndex?: number | null,
    ): ScoreDelta[]
    applyWinScore(
      players: GamePlayer[],
      winnerIndex: number,
      points: number,
      payerIndex?: number | null,
      dealerIndex?: number | null,
    ): number
    applyWinSettlement?(
      players: GamePlayer[],
      winnerIndex: number,
      settlement: WinSettlement,
      dealerIndex: number,
    ): number
  }
  readonly extension?: {
    /** Optional future pattern providers, evaluated after the base hand shape. */
    patternProviders?: readonly unknown[]
    /** Optional future blood-battle/blood-flow settlement hooks. */
    settlementHooks?: readonly unknown[]
  }
}

export const DEFAULT_RULESET = CLASSIC_RULESET

export type RuleSetOverrides = Partial<Pick<RuleSet, 'flow' | 'extension'>> & {
  id?: string
  baseScore?: number
  win?: Partial<RuleSet['win']>
  score?: Partial<RuleSet['score']>
}

/** Merge a ruleset without losing the default behavior of omitted capabilities. */
export function withRuleSetOverrides(base: RuleSet, overrides: RuleSetOverrides): RuleSet {
  return {
    ...base,
    ...overrides,
    win: { ...base.win, ...overrides.win },
    score: { ...base.score, ...overrides.score },
    flow: { ...base.flow, ...overrides.flow },
    extension: overrides.extension ?? base.extension,
  }
}
