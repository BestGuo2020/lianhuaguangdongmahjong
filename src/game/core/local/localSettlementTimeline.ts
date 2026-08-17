import type { RoundResult } from '../contracts/gamePort'
import type { EndGameOptions, TableActionType, TileType } from '../contracts/types'
import { drawHorses } from '../rules/rules'
import { removeLastDiscard } from '../rules/actions'
import type { LocalGameState } from './localGameState'
import { resolveWinTile } from './matchProgress'
import { createSettlementTimeline, type SettlementWinContext } from '../../shared/settlement/settlementTimeline'
import { DEFAULT_RULESET, type RuleSet } from '../rules/ruleset'

interface LocalSettlementTimelineOptions {
  state: LocalGameState
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
}

export function createLocalSettlementTimeline(options: LocalSettlementTimelineOptions) {
  const { state } = options
  const ruleset = options.ruleset ?? DEFAULT_RULESET

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

  const timeline = createSettlementTimeline<EndGameOptions>({
    ...options,
    resolveWinTile: (winner, endOptions) => resolveWinTile(winner, endOptions),
    takeRobbedKongTile: (playerIndex, tile) => takeRobbedKongTile(playerIndex, tile),
    settleWinningDiscard: (from, tile, winnerIndex) => {
      if (!Number.isInteger(from)) return
      const source = state.players[from]
      if (!source || source.discards[source.discards.length - 1] !== tile) return
      removeLastDiscard(source.discards, tile)
      state.lastDiscard.value = null
    },
    getSourceIndex: ({ winner, endOptions, winTile }) => (
      endOptions.robbedKong || endOptions.fourRed
        ? -1
        : (winner.drawnTileIndex >= 0 ? winner.drawnTileIndex : winner.hand.lastIndexOf(winTile))
    ),
    getTableAction: ({ endOptions }) => ({
      type: endOptions.robbedKong ? 'robbed-kong-win' : 'self-draw',
      sourceIndex: endOptions.robbedKong ? (endOptions.robbedKongPlayerIndex ?? null) : null,
    }),
    getWinSound: ({ endOptions }) => endOptions.robbedKong ? 'hu.mp3' : 'zimo.mp3',
    finalizeWin: ({ winnerIndex, winner, endOptions }: SettlementWinContext<EndGameOptions>): RoundResult => {
      const relativeSeat = (((winnerIndex - state.dealer.value) + 4) % 4) as 0 | 1 | 2 | 3
      const { horses, hits } = drawHorses(state.wall.value, 8, relativeSeat)
      // 买马从牌头摸走：头部物理消耗，推进牌头计数保持 3D 牌山一致。
      state.wallHeadDrawn.value += horses.length
      const score = ruleset.score.scoreHand({
        dealer: winnerIndex === state.dealer.value,
        noJoker: !winner.hand.includes('white'),
        fourRed: Boolean(endOptions.fourRed),
        kongBloom: Boolean(endOptions.kongBloom),
        horseHits: hits,
        robbedKong: Boolean(endOptions.robbedKong),
      })
      const totalWon = ruleset.score.applyWinScore(
        state.players,
        winnerIndex,
        score.points,
        endOptions.robbedKong ? (endOptions.robbedKongPlayerIndex ?? null) : null,
        state.dealer.value,
      )
      // 联机客户端据 winType 区分点炮胡(hu.mp3)与自摸(zimo.mp3)；单机无此需要。
      const winType: RoundResult['winType'] = endOptions.robbedKong
        ? 'robbed-kong'
        : (Number.isInteger(endOptions.sourceFrom) ? 'discard' : 'self-draw')
      return {
        winnerIndex,
        winner: winner.name,
        horses,
        hits,
        ...score,
        totalWon,
        winType,
        ...endOptions,
      }
    },
    endDraw: (): RoundResult => {
      const tenpai = state.players
        .map((player, playerIndex) => ({
          playerIndex,
        waits: ruleset.win.waitingTiles(player.hand, options.structuralMeldCount(playerIndex)),
        }))
        .filter((item) => item.waits.length > 0)
        .map((item) => item.playerIndex)
      return {
        draw: true,
        winner: '荒庄',
        horses: [],
        hits: 0,
        multiplier: 0,
        points: 0,
        details: [],
        tenpai,
        dealerTenpai: tenpai.includes(state.dealer.value),
      }
    },
  })

  function isLegalWin(winnerIndex: number, endOptions: EndGameOptions) {
    const winner = state.players[winnerIndex]
    if (!winner) return false
    // 四红是开局特殊结束条件，不要求普通 14 张胡牌结构，但红中数量仍由房主状态确认。
    if (endOptions.fourRed) return winner.redCount >= 4

    const winningHand = endOptions.robbedKong || Number.isInteger(endOptions.sourceFrom)
      ? (endOptions.winTile ? [...winner.hand, endOptions.winTile] : null)
      : winner.hand
    return winningHand !== null
      && ruleset.win.isWinningHand(winningHand, options.structuralMeldCount(winnerIndex))
  }

  return {
    ...timeline,
    endGame(winnerIndex: number, endOptions: EndGameOptions = {}) {
      if (!isLegalWin(winnerIndex, endOptions)) return
      return timeline.endGame(winnerIndex, endOptions)
    },
  }
}
