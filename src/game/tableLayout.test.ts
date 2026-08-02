import { describe, expect, it } from 'vitest'
import { addedKongTileOffset, pointFromSeat, windForSeat } from './tableLayout'

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

describe('seat winds', () => {
  it.each([
    [0, ['东', '南', '西', '北']],
    [1, ['北', '东', '南', '西']],
    [2, ['西', '北', '东', '南']],
    [3, ['南', '西', '北', '东']],
  ])('makes dealer seat %i east and rotates the remaining winds', (dealerIndex, expected) => {
    expect([0, 1, 2, 3].map((playerIndex) => windForSeat(playerIndex, dealerIndex))).toEqual(expected)
  })
})
