// 「莲花麻将」结算：胡牌动画 → 番数/收付结算；流局列出听牌玩家。
import type { RoundResult } from '../core/contracts/gamePort'
import type { TableActionType, TileType } from '../core/contracts/types'
import { resolveWinTile } from '../core/local/matchProgress'
import {
  prefersReducedMotion,
  REDUCED_WIN_EFFECT_DURATION,
  REDUCED_WIN_REVEAL_DURATION,
  WIN_EFFECT_DURATION,
  WIN_EFFECT_SOUND_DELAY,
  WIN_REVEAL_DURATION,
} from '../core/presentation/winEffect'
import { scoreFan, waitingTiles } from './lotusRules'
import { applyWinScore } from './lotusScoring'
import type { LotusEndGameOptions, LotusGameState } from './lotusState'

interface LotusSettlementOptions {
  state: LotusGameState
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

export function createLotusSettlement(options: LotusSettlementOptions) {
  const { state } = options

  function takeRobbedKongTile(playerIndex: number | undefined, tile: TileType, winnerIndex: number) {
    const player = playerIndex == null ? undefined : state.players[playerIndex]
    const meldIndex = player?.melds.findIndex((meld) => (
      meld.type === 'gang' && meld.added && meld.pending && meld.tile === tile
    )) ?? -1
    if (!player || meldIndex < 0) return -1
    const { added: _added, pending: _pending, ...meld } = player.melds[meldIndex]
    player.melds[meldIndex] = { ...meld, type: 'peng', tiles: meld.tiles.slice(0, 3) }
    // 被抢的杠牌加入抢杠者的手牌（作为胡牌张），保证牌数守恒
    state.players[winnerIndex]?.hand.push(tile)
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

  function finalizeWin(winnerIndex: number, endOptions: LotusEndGameOptions) {
    const winner = state.players[winnerIndex]
    const scoresBefore = state.players.map((player) => player.score)
    const winHand = endOptions.winHand ?? winner.hand
    const flags = {
      dealer: winnerIndex === state.dealer.value,
      selfDraw: Boolean(endOptions.selfDraw),
      robbedKong: Boolean(endOptions.robbedKong),
      kongBloom: Boolean(endOptions.kongBloom),
      tianhu: Boolean(endOptions.tianhu),
      dihu: Boolean(endOptions.dihu),
    }
    const score = scoreFan(winHand, options.structuralMeldCount(winnerIndex), state.jokerTiles.value, flags)
      ?? { fan: 1, baseFan: 1, patterns: [{ label: '平胡', multiplier: 1 }], settlement: { H: 100, dealerPays: 200, nonDealerPays: 100, total: 400 } }
    const totalWon = applyWinScore(state.players, winnerIndex, score.settlement, state.dealer.value)
    const winType = endOptions.tianhu ? 'tianhu'
      : endOptions.dihu ? 'dihu'
      : endOptions.robbedKong ? 'robbed-kong'
      : flags.selfDraw ? 'self-draw'
      : 'discard'
    state.result.value = makeRoundResult({
      winnerIndex,
      winner: winner.name,
      multiplier: score.fan,
      totalMultiplier: score.fan,
      points: score.settlement.H,
      details: score.patterns,
      totalWon,
      winType,
      ...endOptions,
    }, scoresBefore)
    state.phase.value = 'settled'
  }

  function endGame(winnerIndex: number, endOptions: LotusEndGameOptions = {}) {
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
      ?? resolveWinTile(winner, endOptions)
    const robbedKongMeldIndex = endOptions.robbedKong
      ? takeRobbedKongTile(endOptions.robbedKongPlayerIndex, winTile, winnerIndex)
      : -1
    const sourceIndex = endOptions.robbedKong
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
    const tableType: TableActionType = endOptions.robbedKong
      ? 'robbed-kong-win'
      : (endOptions.selfDraw ? 'self-draw' : 'discard-win')
    options.showTableAction(
      tableType,
      winnerIndex,
      endOptions.robbedKong ? (endOptions.robbedKongPlayerIndex ?? null) : (endOptions.sourceFrom ?? null),
      winTile,
      -1,
    )
    // 自摸/天胡播自摸音，点炮/抢杠播胡牌音
    options.playSound(endOptions.selfDraw ? 'zimo.mp3' : 'hu.mp3')
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
        waits: waitingTiles(player.hand, options.structuralMeldCount(playerIndex), state.jokerTiles.value),
      }))
      .filter((item) => item.waits.length > 0)
      .map((item) => item.playerIndex)
    state.result.value = makeRoundResult({
      draw: true,
      winner: '荒庄',
      multiplier: 0,
      points: 0,
      details: [],
      tenpai,
      dealerTenpai: tenpai.includes(state.dealer.value),
    }, scoresBefore)
  }

  return { endGame, endDraw, makeRoundResult }
}
