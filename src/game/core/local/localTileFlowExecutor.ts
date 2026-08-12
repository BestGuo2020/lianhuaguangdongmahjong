import type { EndGameOptions } from '../contracts/types'
import type { PlayerController } from '../controllers/playerController'
import { createTileFlowExecutor } from '../../shared/runtime/tileFlowExecutor'
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
  return createTileFlowExecutor({
    ...options,
    getTurnFlow: options.getTurnOrchestrator,
    async handleSpecialDraw(playerIndex, tile, drawAgain) {
      if (tile !== 'red') return undefined
      const player = options.state.players[playerIndex]
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
      await Promise.all([options.playSoundAndWait('gang.mp3'), options.wait(PACE_MS.redKongDraw)])
      if (options.state.phase.value === 'settled') return false
      return drawAgain()
    },
  })
}
