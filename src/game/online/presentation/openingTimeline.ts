import type {
  DealAnimation,
  ActionPrompt,
  GamePhase,
  LastDiscard,
  OpeningStage,
  RefLike,
  RoundResult,
  WinEffect,
} from '../../core/contracts/gamePort'
import type { GamePlayer, TileType, WinPresentation } from '../../core/contracts/types'
import { WALL_TOTAL } from '../../core/rules/wallLayout'
import type { ServerPlayerDto, ServerSnapshot } from '../protocol/dto'
import type { RoundStartMessage } from '../protocol/messages'

export interface OpeningTimelineState {
  phase: RefLike<GamePhase>
  players: GamePlayer[]
  wall: RefLike<TileType[]>
  wallCount: RefLike<number>
  wallHeadDrawn: RefLike<number>
  currentPlayer: RefLike<number>
  selectedIndex: RefLike<number>
  actionPrompt: RefLike<ActionPrompt | null>
  lastDiscard: RefLike<LastDiscard | null>
  result: RefLike<RoundResult | null>
  winEffect: RefLike<WinEffect | null>
  winPresentation: RefLike<WinPresentation | null>
  revealHands: RefLike<boolean>
  winningPlayerIndex: RefLike<number>
  round: RefLike<number>
  dealer: RefLike<number>
  honba: RefLike<number>
  diceValues: RefLike<number[]>
  secondDice: RefLike<[number, number]>
  flipTile: RefLike<TileType | null>
  jokerTiles: RefLike<TileType[]>
  wildcardTiles: RefLike<TileType[]>
  flipStack: RefLike<number | null>
  openingStack: RefLike<number | null>
  wallBreakIndex: RefLike<number>
  diceThrowerIndex: RefLike<number>
  openingStage: RefLike<OpeningStage | null>
  dealAnimation: RefLike<DealAnimation>
}

export interface OpeningTimelineOptions {
  state: OpeningTimelineState
  toLocalSeat: (seat: number) => number
  mapPlayers: (players: ServerPlayerDto[]) => GamePlayer[]
  playSound: (name: string, volume?: number) => unknown
  playSoundAndWait: (name: string, volume?: number) => Promise<void>
  send: (message: Record<string, unknown>) => void
  onFinished: () => void
}

export function createOpeningTimeline({
  state,
  toLocalSeat,
  mapPlayers,
  playSound,
  playSoundAndWait,
  send,
  onFinished,
}: OpeningTimelineOptions) {
  let sequence = 0
  let running = false
  let openingSnapshot: ServerSnapshot | null = null
  let hasSecondDice = false
  let hasFlip = false
  let flipSeat = -1
  let dealStarted = false
  const timers = new Set<number>()

  function wait(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => {
        timers.delete(timer as unknown as number)
        resolve()
      }, delay) as unknown as number
      timers.add(timer)
    })
  }

  function playOpeningSound(name: string) {
    // 音频是装饰层；资源加载或浏览器自动播放策略不能阻塞开局协议。
    void playSoundAndWait(name).catch(() => {})
  }

  function cancel() {
    sequence += 1
    timers.forEach((timer) => globalThis.clearTimeout(timer))
    timers.clear()
    running = false
    openingSnapshot = null
    hasSecondDice = false
    hasFlip = false
    flipSeat = -1
    dealStarted = false
    state.openingStage.value = null
  }

  function isRunning() {
    return running
  }

  function captureSnapshot(snapshot: ServerSnapshot) {
    if (!running) return
    // 发牌动画开始后，普通回合快照可能已经到达；它们应留在 reconciler
    // 的 pendingSnapshot 中，不能重建正在播放的手牌/牌墙，否则动画会回到首批牌。
    if (dealStarted) return
    openingSnapshot = snapshot
    const wallTotal = snapshot.rulesetId === 'lotus-legacy' ? WALL_TOTAL - 2 : WALL_TOTAL
    state.wallCount.value = wallTotal
    const snapshotWall = snapshot.wall ?? []
    const placeholders = Math.max(0, wallTotal - snapshotWall.length)
    state.wall.value = [...Array<TileType>(placeholders).fill('m1'), ...snapshotWall]
    state.wallHeadDrawn.value = 0
    state.secondDice.value = snapshot.secondDice ?? snapshot.dice ?? [1, 1]
    state.flipTile.value = snapshot.flipTile ?? null
    state.jokerTiles.value = snapshot.jokerTiles ?? []
    state.wildcardTiles.value = snapshot.wildcardTiles ?? []
    state.flipStack.value = snapshot.flipStack ?? null
    state.openingStack.value = snapshot.openingStack ?? null
    state.wallBreakIndex.value = snapshot.wallBreakIndex ?? 0
    const skeleton = mapPlayers(snapshot.players)
    state.players.splice(0, state.players.length, ...skeleton.map((player) => ({
      ...player, hand: [], concealedTileCount: 0, discards: [], melds: [], drawnTileIndex: -1,
    })))
  }

  async function deal(currentSequence: number): Promise<boolean> {
    const snapshot = openingSnapshot
    if (!snapshot) return true
    dealStarted = true
    state.openingStage.value = 'deal'
    state.phase.value = 'dealing'
    const source = mapPlayers(snapshot.players)
    const hands = source.map((player) => [...player.hand])
    const concealedRemaining = source.map((player) => player.concealedTileCount ?? player.hand.length)
    state.players.splice(0, state.players.length, ...source.map((player) => ({
      ...player, hand: [], concealedTileCount: 0, discards: [], melds: [], drawnTileIndex: -1,
    })))
    const localDealer = state.dealer.value
    const seatOrder = Array.from(
      { length: state.players.length },
      (_, index) => (localDealer + index) % state.players.length,
    )
    let serial = 0
    const dealBatch = async (playerIndex: number, count: number): Promise<boolean> => {
      if (currentSequence !== sequence) return false
      const dealCount = Math.min(count, concealedRemaining[playerIndex])
      concealedRemaining[playerIndex] -= dealCount
      const remaining = hands[playerIndex].length
      const slice = hands[playerIndex].splice(Math.max(0, remaining - dealCount), dealCount)
      state.players[playerIndex].hand.push(...slice)
      state.players[playerIndex].concealedTileCount = (state.players[playerIndex].concealedTileCount ?? 0) + dealCount
      state.wallCount.value = Math.max(0, state.wallCount.value - dealCount)
      state.wall.value.splice(0, dealCount)
      state.wallHeadDrawn.value += dealCount
      state.dealAnimation.value = { playerIndex, count: dealCount, serial: serial + 1 }
      serial += 1
      playSound('deal.mp3', 0.72)
      await wait(count === 4 ? 260 : 150)
      return true
    }
    for (let batch = 0; batch < 3; batch += 1) {
      for (const playerIndex of seatOrder) {
        if (!(await dealBatch(playerIndex, 4))) return false
      }
    }
    if (!(await dealBatch(localDealer, 2))) return false
    for (const playerIndex of seatOrder) {
      if (playerIndex !== localDealer && !(await dealBatch(playerIndex, 1))) return false
    }
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: serial + 1 }
    return true
  }

  async function run(currentSequence: number) {
    // 莲花开局需要给 3D 骰子完整的起势、翻滚和落地时间；与单机莲花流程保持一致。
    // 经典规则仍保持原有节奏，避免改变只有一次投骰子的远端开局。
    const diceWait = hasSecondDice || hasFlip ? 1600 : 1150
    running = true
    state.openingStage.value = 'start'
    state.diceThrowerIndex.value = state.dealer.value
    playOpeningSound('game_start.mp3')
    await wait(1250)
    if (currentSequence !== sequence) return
    state.openingStage.value = 'dice'
    playOpeningSound('dice.mp3')
    await wait(diceWait)
    if (currentSequence !== sequence) return
    if (hasFlip) {
      state.openingStage.value = 'flip'
      await wait(1200)
      if (currentSequence !== sequence) return
    }
    if (hasSecondDice) {
      if (flipSeat >= 0) state.diceThrowerIndex.value = toLocalSeat(flipSeat)
      state.diceValues.value = [...state.secondDice.value]
      playOpeningSound('dice.mp3')
      await wait(diceWait)
      if (currentSequence !== sequence) return
    }
    if (openingSnapshot && !(await deal(currentSequence))) return
    state.openingStage.value = null
    running = false
    send({ type: 'opening_done' })
    onFinished()
  }

  function start(message: RoundStartMessage) {
    cancel()
    state.round.value = message.round
    state.dealer.value = toLocalSeat(message.dealer)
    state.honba.value = message.honba
    state.diceValues.value = message.dice
    hasSecondDice = message.secondDice != null
    hasFlip = message.flipTile != null && message.flipStack != null
    flipSeat = message.flipSeat ?? -1
    state.secondDice.value = message.secondDice ?? [1, 1]
    state.flipTile.value = message.flipTile ?? null
    state.jokerTiles.value = []
    state.wildcardTiles.value = []
    state.flipStack.value = message.flipStack ?? null
    state.openingStack.value = null
    state.wallBreakIndex.value = 0
    state.players.forEach((player) => {
      player.hand.splice(0)
      player.discards.splice(0)
      player.melds.splice(0)
      player.drawnTileIndex = -1
    })
    state.currentPlayer.value = -1
    state.selectedIndex.value = -1
    state.actionPrompt.value = null
    state.lastDiscard.value = null
    state.result.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = false
    state.winningPlayerIndex.value = -1
    state.phase.value = 'dealing'
    const currentSequence = sequence
    void run(currentSequence)
  }

  return { start, cancel, isRunning, captureSnapshot }
}
