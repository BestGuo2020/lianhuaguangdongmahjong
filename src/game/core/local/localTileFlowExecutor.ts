import type { EndGameOptions } from '../contracts/types'
import type { PlayerController } from '../controllers/playerController'
import { sortTiles, tileAudioFile } from '../rules/tiles'
import { PACE_MS } from './localGameConfig'
import type { LocalGameState } from './localGameState'
import type { createLocalTurnOrchestrator } from './localTurnOrchestrator'

interface LocalTileFlowExecutorOptions {
  state: LocalGameState
  controllers: PlayerController[]
  getTurnOrchestrator(): ReturnType<typeof createLocalTurnOrchestrator>
  endDraw(): unknown
  endGame(winnerIndex: number, options?: EndGameOptions): unknown
  showTableAction(type: 'flower-gang', actorIndex: number, sourceIndex: null, tile: 'red', meldIndex: number): void
  playSound(name: string, volume?: number): unknown
  playSoundAndWait(name: string, volume?: number): Promise<void>
  later(callback: () => void, delay: number): number
  wait(delay: number): Promise<void>
  stopCountdown(): void
}

export function createLocalTileFlowExecutor(options: LocalTileFlowExecutorOptions) {
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
    if (tile === 'red') {
      player.redCount += 1
      if (player.redCount >= 4) {
        player.hand = [...player.hand, tile]
        player.drawnTileIndex = player.hand.length - 1
        options.playSound('give.mp3', 0.7)
        options.endGame(playerIndex, { fourRed: true })
        return false
      }
      player.melds.push({ type: 'flower', tile: 'red', tiles: ['red'] })
      options.showTableAction('flower-gang', playerIndex, null, tile, player.melds.length - 1)
      await Promise.all([
        options.playSoundAndWait('gang.mp3'),
        options.wait(PACE_MS.redKongDraw),
      ])
      if (state.phase.value === 'settled') return false
      return drawFor(playerIndex, true)
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
