import type { RoundResult } from '../contracts/gamePort'
import type { EndGameOptions, TableActionType, TileType } from '../contracts/types'
import { applyWinScore, drawHorses, scoreHand, waitingTiles } from '../rules/rules'
import {
  prefersReducedMotion,
  REDUCED_WIN_EFFECT_DURATION,
  REDUCED_WIN_REVEAL_DURATION,
  WIN_EFFECT_DURATION,
  WIN_EFFECT_SOUND_DELAY,
  WIN_REVEAL_DURATION,
} from '../presentation/winEffect'
import type { LocalGameState } from './localGameState'
import { resolveWinTile } from './matchProgress'

interface LocalSettlementTimelineOptions {
  state: LocalGameState
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
  structuralMeldCount(playerIndex: number): number
  getRoundLabel(): string
}

export function createLocalSettlementTimeline(options: LocalSettlementTimelineOptions) {
  const { state } = options

  function takeRobbedKongTile(playerIndex: number | undefined, tile: TileType) {
    const player = playerIndex == null ? undefined : state.players[playerIndex]
    const meldIndex = player?.melds.findIndex((meld) => (
      meld.type === 'gang' && meld.added && meld.pending && meld.tile === tile
    )) ?? -1
    if (!player || meldIndex < 0) return -1
    const { added: _added, pending: _pending, ...meld } = player.melds[meldIndex]
    player.melds[meldIndex] = { ...meld, type: 'peng', tiles: meld.tiles.slice(0, 3) }
    return meldIndex
  }

  function makeRoundResult(base: RoundResult, scoresBefore: number[]): RoundResult {
    const ranking = state.players
      .map((player, playerIndex) => ({ playerIndex, score: player.score }))
      .sort((a, b) => b.score - a.score || a.playerIndex - b.playerIndex)
    const ranks = new Map(ranking.map((item, index) => [item.playerIndex, index + 1]))
    return {
      ...base,
      roundLabel: options.getRoundLabel(),
      honba: state.honba.value,
      scoreChanges: state.players.map((player, playerIndex) => ({
        playerIndex,
        name: player.name,
        avatar: player.avatar,
        score: player.score,
        delta: player.score - scoresBefore[playerIndex],
        rank: ranks.get(playerIndex),
      })),
    }
  }

  function finalizeWin(winnerIndex: number, endOptions: EndGameOptions) {
    const winner = state.players[winnerIndex]
    const scoresBefore = state.players.map((player) => player.score)
    const { horses, hits } = drawHorses(state.wall.value, 8)
    state.wallHeadDrawn.value += horses.length
    const score = scoreHand({
      dealer: winnerIndex === state.dealer.value,
      noJoker: !winner.hand.includes('white'),
      fourRed: Boolean(endOptions.fourRed),
      kongBloom: Boolean(endOptions.kongBloom),
      horseHits: hits,
      robbedKong: Boolean(endOptions.robbedKong),
    })
    const totalWon = applyWinScore(
      state.players,
      winnerIndex,
      score.points,
      endOptions.robbedKong ? (endOptions.robbedKongPlayerIndex ?? null) : null,
      state.dealer.value,
    )
    state.result.value = makeRoundResult({
      winnerIndex,
      winner: winner.name,
      horses,
      hits,
      ...score,
      totalWon,
      ...endOptions,
    }, scoresBefore)
    state.phase.value = 'settled'
  }

  function endGame(winnerIndex: number, endOptions: EndGameOptions = {}) {
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
    const winTile = resolveWinTile(winner, endOptions)
    const robbedKongMeldIndex = endOptions.robbedKong
      ? takeRobbedKongTile(endOptions.robbedKongPlayerIndex, winTile)
      : -1
    const sourceIndex = endOptions.robbedKong || endOptions.fourRed
      ? -1
      : (winner.drawnTileIndex >= 0 ? winner.drawnTileIndex : winner.hand.lastIndexOf(winTile))
    state.winPresentation.value = {
      winnerIndex,
      tile: winTile,
      sourceIndex,
      robbedKong: Boolean(endOptions.robbedKong),
      robbedKongPlayerIndex: endOptions.robbedKongPlayerIndex ?? -1,
      robbedKongMeldIndex,
    }
    const reducedMotion = prefersReducedMotion()
    const effectDuration = reducedMotion ? REDUCED_WIN_EFFECT_DURATION : WIN_EFFECT_DURATION
    const revealDuration = reducedMotion ? REDUCED_WIN_REVEAL_DURATION : WIN_REVEAL_DURATION
    state.winEffect.value = {
      winnerIndex,
      tile: winTile,
      robbedKong: Boolean(endOptions.robbedKong),
      robbedKongPlayerIndex: endOptions.robbedKongPlayerIndex ?? -1,
      robbedKongMeldIndex,
      duration: effectDuration,
      reducedMotion,
      id: Date.now(),
    }
    options.showTableAction(
      endOptions.robbedKong ? 'robbed-kong-win' : 'self-draw',
      winnerIndex,
      endOptions.robbedKong ? (endOptions.robbedKongPlayerIndex ?? null) : null,
      winTile,
      -1,
    )
    options.playSound(endOptions.robbedKong ? 'hu.mp3' : 'zimo.mp3')
    if (!reducedMotion) {
      options.later(() => { options.playSound('hu_effect_sound.mp3', 0.72) }, WIN_EFFECT_SOUND_DELAY)
    }
    state.announcement.value = null
    options.later(() => {
      state.winEffect.value = null
      state.revealHands.value = true
      state.phase.value = 'revealing'
      options.later(() => finalizeWin(winnerIndex, endOptions), revealDuration)
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
    const tenpai = state.players
      .map((player, playerIndex) => ({
        playerIndex,
        waits: waitingTiles(player.hand, options.structuralMeldCount(playerIndex)),
      }))
      .filter((item) => item.waits.length > 0)
      .map((item) => item.playerIndex)
    state.result.value = makeRoundResult({
      draw: true,
      winner: '荒庄',
      horses: [],
      hits: 0,
      multiplier: 0,
      points: 0,
      details: [],
      tenpai,
      dealerTenpai: tenpai.includes(state.dealer.value),
    }, scoresBefore)
  }

  return { endGame, endDraw, makeRoundResult }
}
