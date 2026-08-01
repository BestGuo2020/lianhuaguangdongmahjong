export function addedKongTileOffset(playerIndex, inset = .72) {
  if (playerIndex === 0) return { x: 0, z: -inset }
  if (playerIndex === 1) return { x: -inset, z: 0 }
  if (playerIndex === 2) return { x: 0, z: inset }
  return { x: inset, z: 0 }
}

export function pointFromSeat(playerIndex, lateral, forward) {
  if (playerIndex === 1) return { x: forward, z: -lateral }
  if (playerIndex === 2) return { x: -lateral, z: -forward }
  if (playerIndex === 3) return { x: -forward, z: lateral }
  return { x: lateral, z: forward }
}
