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

const SEAT_WINDS = ['东', '南', '西', '北'] as const

export function windForSeat(playerIndex: number, dealerIndex: number) {
  const offsetFromDealer = (playerIndex - dealerIndex + SEAT_WINDS.length) % SEAT_WINDS.length
  return SEAT_WINDS[offsetFromDealer]
}
