import type { MatchType, TileType } from '../contracts/types'
import { createWall, shuffle, sortTiles } from '../rules/tiles'
import { wallBreakIndex } from '../rules/wallLayout'
import { MATCH_HANDS } from './localGameConfig'
import type { LocalGameState } from './localGameState'
import { dealInitialHands, resetLocalPlayers } from '../../shared/runtime/localOpening'

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
    resetLocalPlayers(state)
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
    state.lastDiscardSound.value = null
    state.phase.value = 'dealing'
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: 0 }
    state.openingStage.value = 'start'
    state.diceThrowerIndex.value = state.dealer.value

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
    const dealt = await dealInitialHands({
      state,
      takeTile: options.takeTile,
      wait: options.wait,
      playSound: options.playSound,
      isCancelled: () => currentSequence !== sequence,
    })
    if (!dealt) return

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
