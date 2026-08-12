import type { TileType, WinPresentation } from '../contracts/types'

export const WIN_EFFECT_DURATION = 2600
export const WIN_REVEAL_DURATION = 1500
export const WIN_EFFECT_SOUND_DELAY = 320

export const REDUCED_WIN_EFFECT_DURATION = 420
export const REDUCED_WIN_REVEAL_DURATION = 360

export const WIN_DISPLAY_LAYOUTS = Object.freeze([
  Object.freeze({ x: 3.7, y: 0.31, z: 3.35, rotation: 0 }),
  Object.freeze({ x: 3.6, y: 0.31, z: -4.25, rotation: Math.PI / 2 }),
  Object.freeze({ x: -4.5, y: 0.31, z: -4, rotation: Math.PI }),
  Object.freeze({ x: -3.4, y: 0.31, z: 3.9, rotation: -Math.PI / 2 }),
])

export function winDisplayLayout(playerIndex: number) {
  return WIN_DISPLAY_LAYOUTS[playerIndex] ?? WIN_DISPLAY_LAYOUTS[0]
}

export function splitWinningTile(hand: TileType[] = [], presentation: WinPresentation | null = null) {
  const tiles = [...hand]
  if (!presentation?.tile) return { hand: tiles, displayTile: null, removedIndex: -1 }
  if (presentation.robbedKong || presentation.discardWin) {
    return { hand: tiles, displayTile: presentation.tile, removedIndex: -1 }
  }

  const preferredIndex = presentation.sourceIndex
  const removedIndex = Number.isInteger(preferredIndex)
    && preferredIndex >= 0
    && preferredIndex < tiles.length
    && tiles[preferredIndex] === presentation.tile
    ? preferredIndex
    : tiles.lastIndexOf(presentation.tile)

  if (removedIndex >= 0) tiles.splice(removedIndex, 1)
  return { hand: tiles, displayTile: presentation.tile, removedIndex }
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
