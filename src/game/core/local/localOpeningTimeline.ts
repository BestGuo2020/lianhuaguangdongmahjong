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
  /**
   * 分析记录（P1 §6）：**确定性重跑所需的开局参数**在"骰子掷完、牌墙按庄家拆开、还没发牌"
   * 这一刻就齐了，交出去由引擎侧留作本局的复现起点。
   *
   * 为什么非要在这里交出**环状牌墙**：这一刻之后 `state.wall` 会被发出去 —— 局末读 `state.wall`
   * 拿到的是**终局牌墙**，不是复现起点（血流在同一个地方踩过坑）。
   * 注意广麻**没有翻精**：与翻精癞子的同名回调相比，这里没有第二次掷骰、没有翻精墩、
   * 没有开牌断点重排，参数就少一整套（不是漏传）。
   */
  onRoundPrepared?(info: LocalRoundOpeningInfo): void
}

/** 分析记录（P1 §6）：广麻一局的确定性重跑参数（开局时间线在"骰子与牌墙都定下来"时交出）。 */
export interface LocalRoundOpeningInfo {
  /** 环状牌墙 136 张（**牌码**）：**未发牌、未按庄家重排**的那一份。 */
  ringWall: TileType[]
  /** 开局掷骰（两粒）：重跑必须给，否则会被重抽。 */
  openingDice: [number, number]
  dealer: number
  /** 牌山断点（`state.wall[0]` 的物理张位）：由骰子与庄家推出，记下来供交叉校验。 */
  wallBreakIndex: number
  /** 当局开局分（四家）：在**发牌之前**读，所以这里就是这一局真正的起点分数。 */
  openingScores: number[]
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
    /**
     * 确定性子局重跑（分析区 P1 §6）：**当局的庄家**。
     *
     * 为什么必须能从外面指定：庄家决定**发牌起点**（`dealInitialHands` 从庄家起数）与结算的庄闲关系。
     * 重跑第 2 局以后的记录时若沿用默认的 0，手牌从一开始就是另一副牌 —— 正是"拿另一副牌跑了一遍
     * 却宣称复现"这类假结论的来源（实测：第 2 局的庄家座位发到 14 张，而记录里那一家是 13 张）。
     */
    dealer?: number
    /** 确定性子局重跑（分析区 P1 §6）：**当局的开局分数**（四家）。缺了它重跑只能从初始分起步。 */
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
    // 重跑参数必须在**发牌之前**落到状态上：`state.dealer` 是发牌起点的输入（与联机/翻精癞子同款）。
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
    // 分析记录（P1 §6）：**重跑起点**在这里交出 —— 牌墙还没被拆/发出去，`state.wall` 就是
    // "这一局用的那一副 136 张"。此后 `state.wall` 会被发完，局末再读拿到的是终局牌墙。
    options.onRoundPrepared?.({
      ringWall: [...state.wall.value],
      openingDice: [...state.diceValues.value] as [number, number],
      dealer: state.dealer.value,
      wallBreakIndex: breakIndex,
      openingScores: state.players.map((player) => player.score),
    })
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
