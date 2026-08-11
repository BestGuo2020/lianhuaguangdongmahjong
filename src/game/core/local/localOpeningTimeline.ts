import type { MatchType, TileType } from '../contracts/types'
import { createWall, shuffle, sortTiles } from '../rules/tiles'
import { wallBreakIndex } from '../rules/wallLayout'
import { MATCH_HANDS, PLAYER_SEED } from './localGameConfig'
import type { LocalGameState } from './localGameState'

interface LocalOpeningTimelineOptions {
  state: LocalGameState
  clearTimers(): void
  takeTile(fromTail?: boolean): TileType | null
  wait(delay: number): Promise<void>
  later(callback: () => void, delay: number): number
  playSound(name: string, volume?: number): unknown
  playSoundAndWait(name: string, volume?: number): Promise<void>
  announce(text: string, tone?: string): void
  getRoundLabel(): string
  beginTurn(playerIndex: number, options?: { skipDraw?: boolean; fromTail?: boolean }): unknown
  endGame(winnerIndex: number, options: { fourRed: true }): unknown
}

export function createLocalOpeningTimeline(options: LocalOpeningTimelineOptions) {
  const { state } = options
  let sequence = 0

  function cancel() {
    sequence += 1
    state.openingStage.value = null
  }

  function resetPlayers() {
    const previousScores = state.players.map((player) => player.score)
    state.players.splice(0, state.players.length, ...PLAYER_SEED.map((player, index) => ({
      ...player,
      score: previousScores[index] ?? player.score,
      seat: index,
      hand: [],
      discards: [],
      melds: [],
      redCount: 0,
      drawnTileIndex: -1,
    })))
  }

  function receiveDealtTile(playerIndex: number, tile: TileType | null) {
    if (tile) state.players[playerIndex].hand.push(tile)
  }

  function dealOne(playerIndex: number) {
    receiveDealtTile(playerIndex, options.takeTile(false))
  }

  function resolveDealtReds() {
    const seatOrder = state.players.map(
      (_, offset) => (state.dealer.value + offset) % state.players.length,
    )
    for (const playerIndex of seatOrder) {
      const player = state.players[playerIndex]
      while (player.hand.includes('red')) {
        if (player.redCount >= 3) {
          player.redCount += 1
          break
        }
        player.hand.splice(player.hand.indexOf('red'), 1)
        player.redCount += 1
        player.melds.push({ type: 'flower', tile: 'red', tiles: ['red'] })
        const replacement = options.takeTile(true)
        if (replacement) player.hand.push(replacement)
      }
    }
  }

  async function start(mode?: MatchType) {
    options.clearTimers()
    if (mode && MATCH_HANDS[mode]) {
      state.matchType.value = mode
      state.round.value = 1
      state.dealer.value = 0
      state.honba.value = 0
      state.matchFinished.value = false
      state.players.splice(0, state.players.length)
    }
    const currentSequence = sequence
    resetPlayers()
    state.wall.value = shuffle(createWall())
    state.wallHeadDrawn.value = 0
    state.result.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = false
    state.winningPlayerIndex.value = -1
    state.actionPrompt.value = null
    state.pendingKong.value = null
    state.userDrewThisTurn.value = false
    state.selectedIndex.value = -1
    state.lastDiscard.value = null
    state.phase.value = 'dealing'
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: 0 }
    state.openingStage.value = 'start'

    await Promise.all([options.playSoundAndWait('game_start.mp3'), options.wait(1250)])
    if (currentSequence !== sequence) return
    state.diceValues.value = [
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1,
    ]
    state.openingStage.value = 'dice'
    await Promise.all([options.playSoundAndWait('dice.mp3'), options.wait(1150)])
    if (currentSequence !== sequence) return

    const breakIndex = wallBreakIndex(state.diceValues.value)
    state.wall.value = [
      ...state.wall.value.slice(breakIndex),
      ...state.wall.value.slice(0, breakIndex),
    ]
    state.openingStage.value = 'deal'
    const seatOrder = state.players.map(
      (_, offset) => (state.dealer.value + offset) % state.players.length,
    )
    const dealBatch = async (playerIndex: number, count: number) => {
      if (count === 4) options.playSound('deal.mp3', 0.72)
      for (let index = 0; index < count; index += 1) dealOne(playerIndex)
      state.dealAnimation.value = {
        playerIndex,
        count,
        serial: state.dealAnimation.value.serial + 1,
      }
      await options.wait(count === 4 ? 260 : 150)
    }

    for (let batch = 0; batch < 3; batch += 1) {
      for (const playerIndex of seatOrder) {
        await dealBatch(playerIndex, 4)
        if (currentSequence !== sequence) return
      }
    }

    const jumpTiles = Array.from({ length: 5 }, () => options.takeTile(false))
    const jumpOrder = [state.dealer.value, seatOrder[1], seatOrder[2], seatOrder[3], state.dealer.value]
    jumpOrder.forEach((playerIndex, index) => receiveDealtTile(playerIndex, jumpTiles[index]))
    state.dealAnimation.value = {
      playerIndex: state.dealer.value,
      count: 2,
      serial: state.dealAnimation.value.serial + 1,
    }
    await options.wait(260)
    for (const playerIndex of [seatOrder[1], seatOrder[2], seatOrder[3]]) {
      state.dealAnimation.value = {
        playerIndex,
        count: 1,
        serial: state.dealAnimation.value.serial + 1,
      }
      await options.wait(150)
    }
    if (currentSequence !== sequence) return

    resolveDealtReds()
    state.phase.value = 'opening'
    state.openingStage.value = null
    state.dealAnimation.value = {
      playerIndex: -1,
      count: 0,
      serial: state.dealAnimation.value.serial + 1,
    }
    state.players.forEach((player) => { player.hand = sortTiles(player.hand) })
    const fourRedWinner = state.players.findIndex((player) => player.redCount >= 4)
    if (fourRedWinner >= 0) return options.endGame(fourRedWinner, { fourRed: true })
    options.announce(`${options.getRoundLabel()} · 开牌`)
    options.later(() => options.beginTurn(state.dealer.value, { skipDraw: true }), 650)
  }

  return { start, cancel, resetPlayers }
}
