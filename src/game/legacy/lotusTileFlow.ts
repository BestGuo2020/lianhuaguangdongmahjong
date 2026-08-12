// 「莲花麻将」摸牌/出牌执行：无红中花牌逻辑；翻精指示牌已在开局从牌墙移除。
import { sortTiles, tileAudioFile } from '../core/rules/tiles'
import type { LotusController } from './lotusControllers'
import type { LotusGameState, LotusEndGameOptions } from './lotusState'
import type { createLotusTurnOrchestrator } from './lotusTurnOrchestrator'

interface LotusTileFlowOptions {
  state: LotusGameState
  controllers: LotusController[]
  getTurnOrchestrator(): ReturnType<typeof createLotusTurnOrchestrator>
  endDraw(): unknown
  endGame(winnerIndex: number, options?: LotusEndGameOptions): unknown
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): number
  stopCountdown(): void
}

export function createLotusTileFlow(options: LotusTileFlowOptions) {
  const { state } = options

  function takeTile(fromTail = false) {
    if (!state.wall.value.length) return null
    if (!fromTail) state.wallHeadDrawn.value += 1
    return fromTail ? state.wall.value.pop() ?? null : state.wall.value.shift() ?? null
  }

  async function drawFor(playerIndex: number, fromTail = false): Promise<boolean> {
    const player = state.players[playerIndex]
    options.getTurnOrchestrator().markDrawSource(playerIndex, fromTail)
    const tile = takeTile(fromTail)
    if (!tile) {
      options.endDraw()
      return false
    }
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
    options.getTurnOrchestrator().clearDrawSource()
    player.discards.push(tile)
    options.controllers[playerIndex].onDiscarded?.()
    state.lastDiscard.value = { tile, from: playerIndex, id: Date.now() }
    options.playSound('dapai.mp3', 0.8)
    options.later(() => { options.playSound(tileAudioFile(tile)) }, 80)
    state.phase.value = 'checking'
    options.stopCountdown()
    options.getTurnOrchestrator().routeDiscard(playerIndex, tile)
  }

  return { takeTile, drawFor, discardTile }
}
