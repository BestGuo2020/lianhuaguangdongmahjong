// 「莲花麻将」开局时间线：两次掷骰 → 翻精（亮指示牌）→ 发牌 → 天胡判定。
import type { MatchType, TileType } from '../../core/contracts/types'
import { tileName } from '../../core/rules/tiles'
import { MATCH_HANDS } from '../../core/local/localGameConfig'
import { dealInitialHands, resetLocalPlayers } from '../../shared/runtime/localOpening'
import { isWinningHand } from './lotusRules'
import type { LotusEndGameOptions, LotusGameState } from './lotusState'
import {
  buildDrawOrderWall,
  buildRingWall,
  removeFlipStack,
  resolveFlip,
  resolveOpeningStack,
} from './lotusWall'

interface LotusOpeningOptions {
  state: LotusGameState
  clearTimers(): void
  takeTile(fromTail?: boolean): TileType | null
  wait(delay: number): Promise<void>
  later(callback: () => void, delay: number): number
  playSound(name: string, volume?: number): unknown
  playSoundAndWait(name: string, volume?: number): Promise<void>
  announce(text: string, tone?: string): void
  getRoundLabel(): string
  beginTurn(playerIndex: number, options?: { skipDraw?: boolean; fromTail?: boolean }): unknown
  endGame(winnerIndex: number, options?: LotusEndGameOptions): unknown
}

export function createLotusOpening(options: LotusOpeningOptions) {
  const { state } = options
  let sequence = 0

  function cancel() {
    sequence += 1
    state.openingStage.value = null
  }

  function resetPlayers() {
    resetLocalPlayers(state, 2000)
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
    // 先立起牌山（环序 136 张），掷骰前即可看到
    const ring = buildRingWall()
    state.wall.value = [...ring]
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
    // 第一次掷骰由庄家投掷；第二次会在翻精后切换为翻精目标方。
    state.diceThrowerIndex.value = state.dealer.value
    state.flipTile.value = null
    state.jokerTiles.value = []
    state.flipStack.value = null
    state.wallBreakIndex.value = 0
    state.roundFirstDiscard.value = true

    await Promise.all([options.playSoundAndWait('game_start.mp3'), options.wait(1250)])
    if (currentSequence !== sequence) return

    // 第一次掷骰：定翻精方位与墩位
    const firstDice: [number, number] = [roll(), roll()]
    state.diceValues.value = firstDice
    state.openingStage.value = 'dice'
    await Promise.all([options.playSoundAndWait('dice.mp3'), options.wait(1600)])
    if (currentSequence !== sequence) return

    // 翻精：从牌山翻出指示牌（翻精墩整体移出，牌山空出该墩并立起指示牌）
    const { flipSeat, flipStack, flipTile, jokers } = resolveFlip(ring, state.dealer.value, firstDice)
    state.wall.value = removeFlipStack(ring, flipStack)
    state.flipStack.value = flipStack
    state.flipTile.value = flipTile
    state.jokerTiles.value = jokers
    state.openingStage.value = 'flip'
    options.announce(`翻精 ${tileName(flipTile)}`)
    await options.wait(1200)
    if (currentSequence !== sequence) return

    // 第二次掷骰由第一次点数确定的目标方位玩家投掷；必须先切换投掷者，
    // 再写入第二次骰子值，确保骰子动画从一开始就显示正确的玩家。
    state.diceThrowerIndex.value = flipSeat
    // 第二次掷骰：两个骰子的点数和作为开牌依据。
    const secondDice: [number, number] = [roll(), roll()]
    state.diceValues.value = secondDice
    state.openingStage.value = 'dice'
    await Promise.all([options.playSoundAndWait('dice.mp3'), options.wait(1600)])
    if (currentSequence !== sequence) return

    // 开门：从翻精墩顺时针数 T 墩为发牌起点，重排为发牌顺序（环序视觉不变）
    const openingStack = resolveOpeningStack(flipStack, secondDice)
    state.wall.value = buildDrawOrderWall(ring, openingStack, flipStack)
    state.wallBreakIndex.value = openingStack * 2

    state.openingStage.value = 'deal'
    const dealt = await dealInitialHands({
      state,
      takeTile: options.takeTile,
      wait: options.wait,
      playSound: options.playSound,
      isCancelled: () => currentSequence !== sequence,
    })
    if (!dealt) return

    state.phase.value = 'opening'
    state.openingStage.value = null
    state.dealAnimation.value = {
      playerIndex: -1,
      count: 0,
      serial: state.dealAnimation.value.serial + 1,
    }
    options.announce(`${options.getRoundLabel()} · 开牌`)

    // 天胡：庄家起手 14 张即满足胡牌条件
    const dealerIndex = state.dealer.value
    const dealer = state.players[dealerIndex]
    if (isWinningHand(dealer.hand, 0, state.jokerTiles.value)) {
      return options.endGame(dealerIndex, {
        tianhu: true,
        selfDraw: true,
        winHand: [...dealer.hand],
        winTile: dealer.hand[dealer.drawnTileIndex] ?? dealer.hand[dealer.hand.length - 1],
      })
    }
    options.later(() => options.beginTurn(dealerIndex, { skipDraw: true }), 650)
  }

  function roll() {
    return Math.floor(Math.random() * 6) + 1
  }

  return { start, cancel, resetPlayers }
}
