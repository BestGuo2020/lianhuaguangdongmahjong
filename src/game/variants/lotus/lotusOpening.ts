// 「莲花麻将」开局时间线：两次掷骰 → 翻精（亮指示牌）→ 发牌 → 天胡判定。
import type { MatchType, TileType } from '../../core/contracts/types'
import { sortTilesWithJokers, tileName } from '../../core/rules/tiles'
import { MATCH_HANDS } from '../../core/local/localGameConfig'
import { dealInitialHands, resetLocalPlayers, type PlayerSeed } from '../../shared/runtime/localOpening'
import { LOTUS_RULESET } from './lotusRules'
import type { RuleSet } from '../../core/rules/ruleset'
import type { LotusEndGameOptions, LotusGameState } from './lotusState'
import {
  buildDrawOrderWall,
  buildRingWall,
  removeFlipStack,
  resolveFlip,
  resolveOpeningStack,
  wallBreakIndexForOpeningStack,
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
  beginTurn(playerIndex: number, options?: { skipDraw?: boolean; fromTail?: boolean; preDrawn?: boolean }): unknown
  endGame(winnerIndex: number, options?: LotusEndGameOptions): unknown
  ruleset?: RuleSet
  /** AI 座位（1-3）人设种子：昵称/头像（LLM 玩家形象） */
  playerSeeds?: Array<PlayerSeed>
  /** 本家座位 0 的展示形象。 */
  humanPlayerSeed?: PlayerSeed
  /** Continuous modes must offer the opening win through their own claim window. */
  automaticOpeningWin?: boolean
  /**
   * 分析记录（P1 §6）：**确定性重跑所需的开局参数**在这一刻就齐了（环状牌墙 + 两颗骰子 + 庄家），
   * 交出去由引擎侧留作本局的复现起点。
   *
   * 为什么非要在这里交出**环状牌墙**：这一刻之后 `state.wall` 会被移出翻精墩、按开牌断点重排成
   * 摸牌顺序、再发出去 —— 局末读 `state.wall` 拿到的是**终局牌墙**，不是复现起点。
   * 只有"未翻精、未发牌、未重排"的环状牌墙 + 两颗骰子 + 庄家，才能让引擎重新推出翻精方位、
   * 精牌、开牌断点与同一套发牌结果（`resolveFlip` / `resolveOpeningStack` / `buildDrawOrderWall`）。
   */
  onRoundPrepared?(info: LotusRoundOpeningInfo): void
}

/** 分析记录（P1 §6）：一局的确定性重跑参数（开局时间线在"骰子与牌墙都定下来"时交出）。 */
export interface LotusRoundOpeningInfo {
  /** 环状牌墙 136 张（**牌码**）。 */
  ringWall: TileType[]
  firstDice: [number, number]
  secondDice: [number, number]
  dealer: number
}

export function createLotusOpening(options: LotusOpeningOptions) {
  const ruleset = options.ruleset ?? LOTUS_RULESET
  const { state } = options
  let sequence = 0

  function cancel() {
    sequence += 1
    state.openingStage.value = null
  }

  function resetPlayers() {
    resetLocalPlayers(state, 2000, options.playerSeeds, options.humanPlayerSeed)
  }

  async function start(mode?: MatchType, startOptions: {
    waitForTableReady?: () => Promise<void>
    waitForOpeningReady?: () => Promise<void>
    initialWall?: TileType[]
    openingDice?: [number, number]
    openingSecondDice?: [number, number]
    /**
     * 确定性子局重跑（分析区 P1 §6）：当局的庄家。
     *
     * 为什么必须能从外面指定：庄家决定**翻精方位**（`resolveFlip`）与**发牌起点**
     * （`dealInitialHands`），还决定结算的庄闲关系。重跑第 2 局以后的记录时若沿用默认的 0，
     * 翻精与手牌从一开始就是另一副牌 —— 正是"拿另一副牌跑了一遍却宣称复现"这类假结论的来源。
     */
    dealer?: number
    /** 确定性子局重跑（分析区 P1 §6）：当局的开局分数（四家）。缺了它重跑只能从初始分起步。 */
    scores?: readonly number[]
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
    // 重跑参数必须在**掷骰之前**落到状态上：`state.dealer` 是翻精方位与发牌起点的输入。
    if (typeof startOptions.dealer === 'number') state.dealer.value = startOptions.dealer
    const currentSequence = sequence
    resetPlayers()
    // 开局分也要在发牌之前就位（`resetLocalPlayers` 只给一个缺省值，重跑要的是四家各自的开局分）。
    if (startOptions.scores) {
      const scores = startOptions.scores
      state.players.forEach((player, seat) => {
        const score = scores[seat]
        if (typeof score === 'number') player.score = score
      })
    }
    // 先立起牌山（环序 136 张），掷骰前即可看到
    const ring = startOptions.initialWall
      ? [...startOptions.initialWall]
      : buildRingWall()
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
    state.lastDiscardSound.value = null
    state.phase.value = 'dealing'
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: 0 }
    // 第一次掷骰由庄家投掷；第二次会在翻精后切换为翻精目标方。
    state.diceThrowerIndex.value = state.dealer.value
    state.flipTile.value = null
    state.jokerTiles.value = []
    state.wildcardTiles.value = ['white']
    state.flipStack.value = null
    state.flipSeat.value = null
    state.firstDice.value = null
    state.secondDice.value = null
    state.wallBreakIndex.value = 0
    state.roundFirstDiscard.value = true

    if (startOptions.waitForTableReady) {
      await startOptions.waitForTableReady()
      if (currentSequence !== sequence) return
    }
    state.openingStage.value = 'start'

    await Promise.all([options.playSoundAndWait('game_start.mp3'), options.wait(1250)])
    if (currentSequence !== sequence) return

    // 第一次掷骰：定翻精方位与墩位。diceValues 会在第二次掷骰时被覆盖，
    // 必须把第一次点数单独保留，供联机 round_start 的一骰使用（对齐单人模式）。
    const firstDice: [number, number] = startOptions.openingDice
      ? [...startOptions.openingDice] as [number, number]
      : [roll(), roll()]
    state.diceValues.value = firstDice
    state.firstDice.value = firstDice
    state.openingStage.value = 'dice'
    await Promise.all([options.playSoundAndWait('dice.mp3'), options.wait(1600)])
    if (currentSequence !== sequence) return

    // 翻精：从牌山翻出指示牌（翻精墩整体移出，牌山空出该墩并立起指示牌）
    const { flipSeat, flipStack, flipTile, jokers } = resolveFlip(ring, state.dealer.value, firstDice)
    state.flipSeat.value = flipSeat
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
    const secondDice: [number, number] = startOptions.openingSecondDice
      ? [...startOptions.openingSecondDice] as [number, number]
      : [roll(), roll()]
    state.diceValues.value = secondDice
    state.secondDice.value = secondDice
    state.openingStage.value = 'dice'
    await Promise.all([options.playSoundAndWait('dice.mp3'), options.wait(1600)])
    if (currentSequence !== sequence) return

    // 开门：从翻精所在墩顺时针向后数 T+1 墩为发牌/正常摸牌起点，重排为发牌顺序
    const openingStack = resolveOpeningStack(flipStack, secondDice)
    state.wall.value = buildDrawOrderWall(ring, openingStack, flipStack)
    state.wallBreakIndex.value = wallBreakIndexForOpeningStack(openingStack, flipStack)

    // 分析记录（P1 §6）：**重跑起点**在这里交出。此后 `state.wall` 会被发出去、`state.players`
    // 会被发牌改写，局末再读它们拿到的是终局状态（不是复现起点）—— 血流在同一个地方踩过坑。
    options.onRoundPrepared?.({
      ringWall: [...ring],
      firstDice: [...firstDice] as [number, number],
      secondDice: [...secondDice] as [number, number],
      dealer: state.dealer.value,
    })

    state.openingStage.value = 'deal'
    const dealt = await dealInitialHands({
      state,
      takeTile: options.takeTile,
      wait: options.wait,
      playSound: options.playSound,
      sortHand: (hand) => sortTilesWithJokers(hand, state.jokerTiles.value),
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
    if (options.automaticOpeningWin !== false && ruleset.win.isWinningHand(dealer.hand, 0, { jokers: state.jokerTiles.value, jokerSubstitutes: state.wildcardTiles.value })) {
      return options.endGame(dealerIndex, {
        tianhu: true,
        selfDraw: true,
        winHand: [...dealer.hand],
        winTile: dealer.hand[dealer.drawnTileIndex] ?? dealer.hand[dealer.hand.length - 1],
      })
    }
    if (startOptions.waitForOpeningReady) {
      await startOptions.waitForOpeningReady()
      if (currentSequence !== sequence) return
    }
    options.later(() => options.beginTurn(dealerIndex, { skipDraw: true, preDrawn: true }), 650)
  }

  function roll() {
    return Math.floor(Math.random() * 6) + 1
  }

  return { start, cancel, resetPlayers }
}
