import type { TileType } from '../../core/contracts/types'
import { tileAudioFile } from '../../core/rules/tiles'

/** Existing tile-name route and completion signal, shared by local rulesets. */
export function playDiscardName(tile: TileType, options: {
  playSound(name: string): unknown
  playSoundAndWait?: (name: string) => Promise<void>
  current?: () => boolean
}): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(() => {
    if (options.current?.() === false) return resolve()
    try {
      const playback = options.playSoundAndWait?.(tileAudioFile(tile))
      if (playback) { void playback.then(resolve, resolve); return }
      options.playSound(tileAudioFile(tile))
    } catch { /* Missing audio must never block a turn. */ }
    resolve()
  }, 80))
}
