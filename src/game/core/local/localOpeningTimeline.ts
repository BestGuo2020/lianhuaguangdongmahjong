import type { MatchType, TileType } from '../contracts/types'
import { createWall, shuffle, sortTiles } from '../rules/tiles'
import { wallBreakIndexForDealer } from '../rules/wallLayout'
import { MATCH_HANDS } from './localGameConfig'
import type { LocalGameState } from './localGameState'
import { dealInitialHands, resetLocalPlayers, type PlayerSeed } from '../../shared/runtime/localOpening'

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
  beginTurn(playerIndex: number, options?: { skipDraw?: boolean; fromTail?: boolean; preDrawn?: boolean }): unknown
  endGame(winnerIndex: number, options: { fourRed: true }): unknown
  /** AI 座位（1-3）人设种子：昵称/头像（LLM 玩家形象） */
  playerSeeds?: Array<PlayerSeed>
  /** 本家座位 0 的展示形象。 */
  humanPlayerSeed?: PlayerSeed
}

export function createLocalOpeningTimeline(options: LocalOpeningTimelineOptions) {
  const { state } = options
  let sequence = 0

  function cancel() {
    sequence += 1
    state.openingStage.value = null
  }

  function resetPlayers() {
    resetLocalPlayers(state, undefined, options.playerSeeds, options.humanPlayerSeed)
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

  async function start(mode?: MatchType, startOptions: {
    waitForTableReady?: () => Promise<void>
    waitForOpeningReady?: () => Promise<void>
    initialWall?: TileType[]
    openingDice?: [number, number]
  } = {}) {
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
    state.wall.value = startOptions.initialWall
      ? [...startOptions.initialWall]
      : shuffle(createWall())
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
    state.diceThrowerIndex.value = state.dealer.value
    state.wallBreakIndex.value = 0

    if (startOptions.waitForTableReady) {
      await startOptions.waitForTableReady()
      if (currentSequence !== sequence) return
    }
    state.openingStage.value = 'start'

    await Promise.all([options.playSoundAndWait('game_start.mp3'), options.wait(1250)])
    if (currentSequence !== sequence) return
    state.diceValues.value = startOptions.openingDice
      ? [...startOptions.openingDice]
      : [
          Math.floor(Math.random() * 6) + 1,
          Math.floor(Math.random() * 6) + 1,
        ]
    state.openingStage.value = 'dice'
    await Promise.all([options.playSoundAndWait('dice.mp3'), options.wait(1150)])
    if (currentSequence !== sequence) return

    const breakIndex = wallBreakIndexForDealer(state.diceValues.value, state.dealer.value)
    // 记录拆墙断点，供房主快照下发（联机模式 3D 牌山开口位置与单人模式一致）。
    state.wallBreakIndex.value = breakIndex
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
    if (startOptions.waitForOpeningReady) {
      await startOptions.waitForOpeningReady()
      if (currentSequence !== sequence) return
    }
    options.later(() => options.beginTurn(state.dealer.value, { skipDraw: true, preDrawn: true }), 650)
  }

  return { start, cancel, resetPlayers }
}
