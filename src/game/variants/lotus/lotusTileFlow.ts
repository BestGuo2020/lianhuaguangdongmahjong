import { createTileFlowExecutor } from '../../shared/runtime/tileFlowExecutor'
import type { LotusController } from './lotusControllers'
import type { LotusGameState } from './lotusState'
import type { createLotusTurnOrchestrator } from './lotusTurnOrchestrator'
import { takeLotusTailTile } from './lotusWall'

interface LotusTileFlowOptions {
  state: LotusGameState
  controllers: LotusController[]
  getTurnOrchestrator(): ReturnType<typeof createLotusTurnOrchestrator>
  endDraw(): unknown
  playSound(name: string, volume?: number): unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  later(callback: () => void, delay: number): number
  stopCountdown(): void
}

export function createLotusTileFlow(options: LotusTileFlowOptions) {
  return createTileFlowExecutor({
    ...options,
    getTurnFlow: options.getTurnOrchestrator,
    takeTailTile: takeLotusTailTile,
  })
}
