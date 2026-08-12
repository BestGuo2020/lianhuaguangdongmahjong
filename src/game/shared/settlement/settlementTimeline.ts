import type { GamePhase, RefLike, RoundResult } from '../../core/contracts/gamePort'
import type { GamePlayer, TableActionType, TileType, WinPresentation } from '../../core/contracts/types'
import {
  prefersReducedMotion,
  REDUCED_WIN_EFFECT_DURATION,
  REDUCED_WIN_REVEAL_DURATION,
  WIN_EFFECT_DURATION,
  WIN_EFFECT_SOUND_DELAY,
  WIN_REVEAL_DURATION,
} from '../../core/presentation/winEffect'
import { makeRoundResult as buildRoundResult } from './roundResult'

export interface SettlementEndOptions {
  winTile?: TileType
  winHand?: TileType[]
  fourRed?: boolean
  selfDraw?: boolean
  kongBloom?: boolean
  robbedKong?: boolean
  robbedKongPlayerIndex?: number
  tianhu?: boolean
  dihu?: boolean
  sourceFrom?: number
}

interface SettlementState {
  phase: RefLike<GamePhase>
  players: GamePlayer[]
  wall: RefLike<TileType[]>
  wallHeadDrawn: RefLike<number>
  currentPlayer: RefLike<number>
  userDrewThisTurn: RefLike<boolean>
  actionPrompt: RefLike<unknown>
  pendingKong: RefLike<unknown>
  announcement: RefLike<unknown>
  openingStage: RefLike<unknown>
  scoreFlowEvent: RefLike<unknown>
  tableActionEvent: RefLike<unknown>
  result: RefLike<RoundResult | null>
  winEffect: RefLike<{
    winnerIndex: number
    tile: TileType
    robbedKong: boolean
    robbedKongPlayerIndex: number
    robbedKongMeldIndex: number
    duration: number
    reducedMotion: boolean
    id: number
  } | null>
  winPresentation: RefLike<WinPresentation | null>
  revealHands: RefLike<boolean>
  winningPlayerIndex: RefLike<number>
  honba: RefLike<number>
}

export interface SettlementWinContext<E extends SettlementEndOptions> {
  winnerIndex: number
  winner: GamePlayer
  endOptions: E
  winTile: TileType
  scoresBefore: number[]
}

export interface SettlementDrawContext {
  scoresBefore: number[]
}

export interface SettlementTimelineOptions<E extends SettlementEndOptions, S extends SettlementState = SettlementState> {
  state: S
  clearTimers(): void
  later(callback: () => void, delay: number): number
  playSound(name: string, volume?: number): unknown
  showTableAction(
    type: TableActionType,
    actorIndex: number,
    sourceIndex: number | null,
    tile: TileType,
    meldIndex: number,
  ): void
  getRoundLabel(): string
  resolveWinTile?(winner: GamePlayer, endOptions: E): TileType
  takeRobbedKongTile?(playerIndex: number | undefined, tile: TileType, winnerIndex: number): number
  getSourceIndex?(context: SettlementWinContext<E>): number
  getTableAction?(context: SettlementWinContext<E>): { type: TableActionType; sourceIndex: number | null }
  getWinSound?(context: SettlementWinContext<E>): string
  finalizeWin(context: SettlementWinContext<E>): RoundResult
  endDraw(context: SettlementDrawContext): RoundResult
}

export function createSettlementTimeline<E extends SettlementEndOptions, S extends SettlementState = SettlementState>(
  options: SettlementTimelineOptions<E, S>,
) {
  const { state } = options

  function makeRoundResult(base: RoundResult, scoresBefore: number[]) {
    return buildRoundResult(
      { players: state.players, roundLabel: options.getRoundLabel(), honba: state.honba.value },
      base,
      scoresBefore,
    )
  }

  function endGame(winnerIndex: number, endOptions = {} as E) {
    if (['win-effect', 'revealing', 'settled', 'finished'].includes(state.phase.value)) return
    options.clearTimers()
    state.scoreFlowEvent.value = null
    state.tableActionEvent.value = null
    state.phase.value = 'win-effect'
    state.openingStage.value = null
    state.currentPlayer.value = -1
    state.userDrewThisTurn.value = false
    state.actionPrompt.value = null
    state.pendingKong.value = null

    const winner = state.players[winnerIndex]
    state.winningPlayerIndex.value = winnerIndex
    const winTile = endOptions.winTile
      ?? (endOptions.winHand?.[endOptions.winHand.length - 1])
      ?? options.resolveWinTile?.(winner, endOptions)
      ?? winner.hand[winner.drawnTileIndex]
      ?? winner.hand[winner.hand.length - 1]
    const robbedKongMeldIndex = endOptions.robbedKong
      ? (options.takeRobbedKongTile?.(endOptions.robbedKongPlayerIndex, winTile, winnerIndex) ?? -1)
      : -1
    const context: SettlementWinContext<E> = {
      winnerIndex,
      winner,
      endOptions,
      winTile,
      scoresBefore: [],
    }
    const sourceIndex = options.getSourceIndex?.(context)
      ?? (winner.drawnTileIndex >= 0 ? winner.drawnTileIndex : winner.hand.lastIndexOf(winTile))
    const tableAction = options.getTableAction?.(context) ?? {
      type: endOptions.robbedKong ? 'robbed-kong-win' : 'self-draw',
      sourceIndex: endOptions.robbedKong ? (endOptions.robbedKongPlayerIndex ?? null) : null,
    }
    const reducedMotion = prefersReducedMotion()
    const effectDuration = reducedMotion ? REDUCED_WIN_EFFECT_DURATION : WIN_EFFECT_DURATION
    const revealDuration = reducedMotion ? REDUCED_WIN_REVEAL_DURATION : WIN_REVEAL_DURATION
    const robbedKongPlayerIndex = endOptions.robbedKongPlayerIndex ?? -1
    const presentation: WinPresentation = {
      winnerIndex,
      tile: winTile,
      sourceIndex,
      robbedKong: Boolean(endOptions.robbedKong),
      robbedKongPlayerIndex,
      robbedKongMeldIndex,
    }
    state.winPresentation.value = presentation
    state.winEffect.value = {
      ...presentation,
      duration: effectDuration,
      reducedMotion,
      id: Date.now(),
    }
    options.showTableAction(tableAction.type, winnerIndex, tableAction.sourceIndex, winTile, -1)
    options.playSound(options.getWinSound?.(context) ?? (endOptions.selfDraw ? 'zimo.mp3' : 'hu.mp3'))
    if (!reducedMotion) {
      options.later(() => { options.playSound('hu_effect_sound.mp3', 0.72) }, WIN_EFFECT_SOUND_DELAY)
    }
    state.announcement.value = null
    options.later(() => {
      state.winEffect.value = null
      state.revealHands.value = true
      state.phase.value = 'revealing'
      options.later(() => {
        const scoresBefore = state.players.map((player) => player.score)
        state.result.value = makeRoundResult(options.finalizeWin({ ...context, scoresBefore }), scoresBefore)
        state.phase.value = 'settled'
      }, revealDuration)
    }, effectDuration)
  }

  function endDraw() {
    options.clearTimers()
    state.phase.value = 'settled'
    state.openingStage.value = null
    state.currentPlayer.value = -1
    state.userDrewThisTurn.value = false
    state.actionPrompt.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = true
    state.winningPlayerIndex.value = -1
    const scoresBefore = state.players.map((player) => player.score)
    state.result.value = makeRoundResult(options.endDraw({ scoresBefore }), scoresBefore)
  }

  return { endGame, endDraw, makeRoundResult }
}
