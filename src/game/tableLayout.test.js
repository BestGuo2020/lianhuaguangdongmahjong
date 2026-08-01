import { describe, expect, it } from 'vitest'
import { addedKongTileOffset } from './tableLayout'

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
