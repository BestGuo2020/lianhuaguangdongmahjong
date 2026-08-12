import type { GamePhase, LastDiscard, RefLike } from '../../core/contracts/gamePort'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import { sortTiles, tileAudioFile } from '../../core/rules/tiles'

interface TileFlowState {
  players: GamePlayer[]
  wall: RefLike<TileType[]>
  wallHeadDrawn: RefLike<number>
  phase: RefLike<GamePhase>
  lastDiscard: RefLike<LastDiscard | null>
}
interface TurnFlow {
  markDrawSource(playerIndex: number, fromTail: boolean): void
  clearDrawSource(): void
  routeDiscard(playerIndex: number, tile: TileType): unknown
}
interface TileFlowOptions {
  state: TileFlowState
  controllers: Array<{ onDiscarded?(): void }>
  getTurnFlow(): TurnFlow
  endDraw(): unknown
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): number
  stopCountdown(): void
  handleSpecialDraw?: (
    playerIndex: number,
    tile: TileType,
    drawAgain: () => Promise<boolean>,
  ) => Promise<boolean | undefined>
  takeTailTile?: (wall: TileType[], headDrawn: number) => TileType | null
}

export function createTileFlowExecutor(options: TileFlowOptions) {
  const { state } = options
  function takeTile(fromTail = false) {
    if (!state.wall.value.length) return null
    if (!fromTail) state.wallHeadDrawn.value += 1
    if (!fromTail) return state.wall.value.shift() ?? null
    return options.takeTailTile?.(state.wall.value, state.wallHeadDrawn.value)
      ?? state.wall.value.pop()
      ?? null
  }
  async function drawFor(playerIndex: number, fromTail = false): Promise<boolean> {
    const player = state.players[playerIndex]
    options.getTurnFlow().markDrawSource(playerIndex, fromTail)
    const tile = takeTile(fromTail)
    if (!tile) {
      options.endDraw()
      return false
    }
    const specialResult = await options.handleSpecialDraw?.(playerIndex, tile, () => drawFor(playerIndex, true))
    if (specialResult !== undefined) return specialResult
    player.hand = [...player.hand, tile]
    player.drawnTileIndex = player.hand.length - 1
    options.playSound('give.mp3', 0.7)
    return true
  }
  function discardTile(playerIndex: number, requestedIndex: number) {
    const player = state.players[playerIndex]
    const handIndex = Math.min(requestedIndex, player.hand.length - 1)
    const [tile] = player.hand.splice(handIndex, 1)
    if (!tile) return
    player.hand = sortTiles(player.hand)
    player.drawnTileIndex = -1
    options.getTurnFlow().clearDrawSource()
    player.discards.push(tile)
    options.controllers[playerIndex].onDiscarded?.()
    state.lastDiscard.value = { tile, from: playerIndex, id: Date.now() }
    options.playSound('dapai.mp3', 0.8)
    options.later(() => { options.playSound(tileAudioFile(tile)) }, 80)
    state.phase.value = 'checking'
    options.stopCountdown()
    options.getTurnFlow().routeDiscard(playerIndex, tile)
  }
  return { takeTile, drawFor, discardTile }
}
