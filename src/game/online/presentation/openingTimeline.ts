import type { RefLike, LastDiscard, RoundResult } from '../../core/gamePort'
import type { ActionPrompt } from '../../core/playerController'
import type { GamePlayer, TileType, WinPresentation } from '../../core/types'
import { WALL_TOTAL } from '../../core/wallLayout'
import type { ServerSnapshot } from '../protocol/dto'
import type { RoundStartMessage } from '../protocol/messages'

export interface OpeningTimelineState {
  phase: RefLike<string>
  players: GamePlayer[]
  wall: RefLike<TileType[]>
  wallCount: RefLike<number>
  wallHeadDrawn: RefLike<number>
  currentPlayer: RefLike<number>
  selectedIndex: RefLike<number>
  actionPrompt: RefLike<ActionPrompt | null>
  lastDiscard: RefLike<LastDiscard | null>
  result: RefLike<RoundResult | null>
  winEffect: RefLike<RoundResult | null>
  winPresentation: RefLike<WinPresentation | null>
  revealHands: RefLike<boolean>
  winningPlayerIndex: RefLike<number>
  round: RefLike<number>
  dealer: RefLike<number>
  honba: RefLike<number>
  diceValues: RefLike<number[]>
  openingStage: RefLike<string | null>
  dealAnimation: RefLike<{ playerIndex: number; count: number; serial: number }>
}

export interface OpeningTimelineOptions {
  state: OpeningTimelineState
  toLocalSeat: (seat: number) => number
  mapPlayers: (players: GamePlayer[]) => GamePlayer[]
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

  function cancel() {
    sequence += 1
    timers.forEach((timer) => globalThis.clearTimeout(timer))
    timers.clear()
    running = false
    openingSnapshot = null
    state.openingStage.value = null
  }

  function isRunning() {
    return running
  }

  function captureSnapshot(snapshot: ServerSnapshot) {
    if (!running || openingSnapshot) return
    openingSnapshot = snapshot
    state.wallCount.value = WALL_TOTAL
    const snapshotWall = snapshot.wall ?? []
    const placeholders = Math.max(0, WALL_TOTAL - snapshotWall.length)
    state.wall.value = [...Array<TileType>(placeholders).fill('m1'), ...snapshotWall]
    state.wallHeadDrawn.value = 0
    const skeleton = mapPlayers(snapshot.players)
    state.players.splice(0, state.players.length, ...skeleton.map((player) => ({
      ...player, hand: [], discards: [], melds: [], drawnTileIndex: -1,
    })))
  }

  async function deal(currentSequence: number): Promise<boolean> {
    const snapshot = openingSnapshot
    if (!snapshot) return true
    state.openingStage.value = 'deal'
    state.phase.value = 'dealing'
    const source = mapPlayers(snapshot.players)
    const hands = source.map((player) => [...player.hand])
    state.players.splice(0, state.players.length, ...source.map((player) => ({
      ...player, hand: [], discards: [], melds: [], drawnTileIndex: -1,
    })))
    const localDealer = state.dealer.value
    const seatOrder = Array.from(
      { length: state.players.length },
      (_, index) => (localDealer + index) % state.players.length,
    )
    let serial = 0
    const dealBatch = async (playerIndex: number, count: number): Promise<boolean> => {
      if (currentSequence !== sequence) return false
      const remaining = hands[playerIndex].length
      const slice = hands[playerIndex].splice(remaining - count, count)
      state.players[playerIndex].hand.push(...slice)
      state.wallCount.value = Math.max(0, state.wallCount.value - count)
      state.wall.value.splice(0, count)
      state.wallHeadDrawn.value += count
      state.dealAnimation.value = { playerIndex, count, serial: serial + 1 }
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
    running = true
    state.openingStage.value = 'start'
    await Promise.all([playSoundAndWait('game_start.mp3'), wait(1250)])
    if (currentSequence !== sequence) return
    state.openingStage.value = 'dice'
    await Promise.all([playSoundAndWait('dice.mp3'), wait(1150)])
    if (currentSequence !== sequence) return
    if (openingSnapshot && !(await deal(currentSequence))) return
    state.openingStage.value = null
    running = false
    onFinished()
    send({ type: 'opening_done' })
  }

  function start(message: RoundStartMessage) {
    cancel()
    state.round.value = message.round
    state.dealer.value = toLocalSeat(message.dealer)
    state.honba.value = message.honba
    state.diceValues.value = message.dice
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
