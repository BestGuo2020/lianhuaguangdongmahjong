import { describe, expect, it } from 'vitest'
import { addedKongTileOffset, pointFromSeat } from './tableLayout'

describe('added kong tile layout', () => {
  it.each([
    [0, { x: 0, z: -.72 }],
    [1, { x: -.72, z: 0 }],
    [2, { x: 0, z: .72 }],
    [3, { x: .72, z: 0 }],
  ])('places seat %i fourth tile beside the sideways tile toward center', (playerIndex, expected) => {
    expect(addedKongTileOffset(playerIndex)).toEqual(expected)
  })
})

describe('seat-relative table position', () => {
  it.each([
    [0, { x: .6, z: 5.2 }],
    [1, { x: 5.2, z: -.6 }],
    [2, { x: -.6, z: -5.2 }],
    [3, { x: -5.2, z: .6 }],
  ])('rotates a throw origin to seat %i', (playerIndex, expected) => {
    expect(pointFromSeat(playerIndex, .6, 5.2)).toEqual(expected)
  })
})
