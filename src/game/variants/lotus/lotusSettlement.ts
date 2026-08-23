import type { RoundResult } from '../../core/contracts/gamePort'
import type { TableActionType, TileType } from '../../core/contracts/types'
import { LOTUS_RULESET } from './lotusRules'
import type { RuleSet } from '../../core/rules/ruleset'
import { applyWinScore } from './lotusScoring'
import { removeLastDiscard } from '../../core/rules/actions'
import type { LotusEndGameOptions, LotusGameState } from './lotusState'
import { createSettlementTimeline, type SettlementWinContext } from '../../shared/settlement/settlementTimeline'
import { announceLocalLlmWin, isLocalLlmSeat } from '../../core/presentation/localLlmVoiceRegistry'

interface LotusSettlementOptions {
  state: LotusGameState
  clearTimers(): void
  later(callback: () => void, delay: number): number
  playSound(name: string, volume?: number): unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  showTableAction(
    type: TableActionType,
    actorIndex: number,
    sourceIndex: number | null,
    tile: TileType,
    meldIndex: number,
  ): void
  structuralMeldCount(playerIndex: number): number
  getRoundLabel(): string
  ruleset?: RuleSet
  /** 单机默认读取全局 LLM 语音注册表；无头联机引擎必须显式覆盖为 false，避免真人座位误播。 */
  isLlmVoiceSeat?: (seat: number) => boolean
  announceLlmWin?: (seat: number, type: 'self-draw' | 'discard-win' | 'robbed-kong-win') => boolean
}

export function createLotusSettlement(options: LotusSettlementOptions) {
  const { state } = options
  const ruleset = options.ruleset ?? LOTUS_RULESET
  const isLlmVoiceSeat = options.isLlmVoiceSeat ?? isLocalLlmSeat
  const announceLlmWin = options.announceLlmWin ?? announceLocalLlmWin

  function takeRobbedKongTile(playerIndex: number | undefined, tile: TileType, winnerIndex: number) {
    const player = playerIndex == null ? undefined : state.players[playerIndex]
    const meldIndex = player?.melds.findIndex((meld) => (
      meld.type === 'gang' && meld.added && meld.pending && meld.tile === tile
    )) ?? -1
    if (!player || meldIndex < 0) return -1
    const { added: _added, pending: _pending, ...meld } = player.melds[meldIndex]
    player.melds[meldIndex] = { ...meld, type: 'peng', tiles: meld.tiles.slice(0, 3) }
    state.players[winnerIndex]?.hand.push(tile)
    return meldIndex
  }

  const timeline = createSettlementTimeline<LotusEndGameOptions>({
    ...options,
    playSound: (name, volume) => {
      const suppress = isLlmVoiceSeat(state.winningPlayerIndex.value)
        && (name === 'zimo.mp3' || name === 'hu.mp3' || name === 'hu_effect_sound.mp3')
      if (!suppress) return volume === undefined
        ? options.playSound(name)
        : options.playSound(name, volume)
    },
    takeRobbedKongTile,
    settleWinningDiscard: (from, tile, winnerIndex) => {
      if (!Number.isInteger(from)) return
      const source = state.players[from]
      if (!source || source.discards[source.discards.length - 1] !== tile) return
      removeLastDiscard(source.discards, tile)
      state.lastDiscard.value = null
    },
    getSourceIndex: ({ endOptions, winner, winTile }) => (
      endOptions.robbedKong
        ? -1
        : (winner.drawnTileIndex >= 0 ? winner.drawnTileIndex : winner.hand.lastIndexOf(winTile))
    ),
    getTableAction: ({ endOptions }: SettlementWinContext<LotusEndGameOptions>) => ({
      type: endOptions.robbedKong
        ? 'robbed-kong-win'
        : (endOptions.selfDraw ? 'self-draw' : 'discard-win'),
      sourceIndex: endOptions.robbedKong
        ? (endOptions.robbedKongPlayerIndex ?? null)
        : (endOptions.sourceFrom ?? null),
    }),
    getWinSound: ({ endOptions }) => endOptions.selfDraw ? 'zimo.mp3' : 'hu.mp3',
    finalizeWin: ({ winnerIndex, winner, endOptions }: SettlementWinContext<LotusEndGameOptions>): RoundResult => {
      const winHand = endOptions.winHand ?? winner.hand
      const flags = {
        dealer: winnerIndex === state.dealer.value,
        selfDraw: Boolean(endOptions.selfDraw),
        robbedKong: Boolean(endOptions.robbedKong),
        kongBloom: Boolean(endOptions.kongBloom),
        tianhu: Boolean(endOptions.tianhu),
        dihu: Boolean(endOptions.dihu),
      }
      const ordinaryJokers = !endOptions.selfDraw && endOptions.winTile
        && (state.jokerTiles.value.includes(endOptions.winTile) || state.wildcardTiles.value.includes(endOptions.winTile))
        ? [endOptions.winTile]
        : []
      const score = ruleset.fan?.scoreFan(
        winHand,
        options.structuralMeldCount(winnerIndex),
        flags,
        { jokers: state.jokerTiles.value, ordinaryJokers, jokerSubstitutes: state.wildcardTiles.value },
      )
        ?? { fan: 1, baseFan: 1, patterns: [{ label: '平胡', multiplier: 1 }], settlement: { H: 100, dealerPays: 200, nonDealerPays: 100, total: 400 } }
      const totalWon = ruleset.score.applyWinSettlement
        ? ruleset.score.applyWinSettlement(state.players, winnerIndex, score.settlement, state.dealer.value)
        : applyWinScore(state.players, winnerIndex, score.settlement, state.dealer.value)
      const winType = endOptions.tianhu ? 'tianhu'
        : endOptions.dihu ? 'dihu'
        : endOptions.robbedKong ? 'robbed-kong'
        : flags.selfDraw ? 'self-draw'
        : 'discard'
      return {
        winnerIndex,
        winner: winner.name,
        multiplier: score.fan,
        totalMultiplier: score.fan,
        points: score.settlement.H,
        details: score.patterns,
        totalWon,
        winType,
        ...endOptions,
      }
    },
    endDraw: (): RoundResult => {
      const tenpai = state.players
        .map((player, playerIndex) => ({
          playerIndex,
        waits: ruleset.win.waitingTiles(player.hand, options.structuralMeldCount(playerIndex), { jokers: state.jokerTiles.value, jokerSubstitutes: state.wildcardTiles.value }),
        }))
        .filter((item) => item.waits.length > 0)
        .map((item) => item.playerIndex)
      return {
        draw: true,
        winner: '荒庄',
        multiplier: 0,
        points: 0,
        details: [],
        tenpai,
        dealerTenpai: tenpai.includes(state.dealer.value),
      }
    },
  })

  function isLegalWin(winnerIndex: number, endOptions: LotusEndGameOptions) {
    const winner = state.players[winnerIndex]
    if (!winner) return false
    const winningHand = endOptions.robbedKong || !endOptions.selfDraw
      ? (endOptions.winTile ? [...winner.hand, endOptions.winTile] : null)
      : winner.hand
    return winningHand !== null
      && ruleset.win.isWinningHand(
        winningHand,
        options.structuralMeldCount(winnerIndex),
        {
          jokers: state.jokerTiles.value,
          ordinaryJokers: endOptions.winTile
            && (state.jokerTiles.value.includes(endOptions.winTile) || state.wildcardTiles.value.includes(endOptions.winTile))
            ? [endOptions.winTile]
            : [],
          jokerSubstitutes: state.wildcardTiles.value,
        },
      )
  }

  return {
    ...timeline,
    endGame(winnerIndex: number, endOptions: LotusEndGameOptions = {}) {
      if (!isLegalWin(winnerIndex, endOptions)) return
      const winType = endOptions.robbedKong
        ? 'robbed-kong-win'
        : endOptions.selfDraw ? 'self-draw' : 'discard-win'
      announceLlmWin(winnerIndex, winType)
      return timeline.endGame(winnerIndex, endOptions)
    },
  }
}
