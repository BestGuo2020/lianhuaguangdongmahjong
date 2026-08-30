import { createTileFlowExecutor } from '../../shared/runtime/tileFlowExecutor'
import type { LotusController } from './lotusControllers'
import type { LotusGameState } from './lotusState'
import type { createLotusTurnOrchestrator } from './lotusTurnOrchestrator'
import { sortTilesWithJokers } from '../../core/rules/tiles'
import { takeLotusTailTile } from './lotusWall'
import type { FollowDealerTracker } from '../../shared/runtime/followDealer'
import type { GamePlayer } from '../../core/contracts/types'

interface LotusTileFlowOptions {
  state: LotusGameState
  controllers: LotusController[]
  getTurnOrchestrator(): ReturnType<typeof createLotusTurnOrchestrator>
  endDraw(): unknown
  playSound(name: string, volume?: number): unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  shouldAnnounceDiscard?: (playerIndex: number, player: GamePlayer) => boolean
  later(callback: () => void, delay: number): number
  stopCountdown(): void
  followDealer?: FollowDealerTracker
}

export function createLotusTileFlow(options: LotusTileFlowOptions) {
  return createTileFlowExecutor({
    ...options,
    sortHand: (hand) => sortTilesWithJokers(hand, options.state.jokerTiles.value),
    getTurnFlow: options.getTurnOrchestrator,
    takeTailTile: takeLotusTailTile,
  })
}
