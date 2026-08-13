import { describe, expect, it } from 'vitest'
import { tileMarkerFor } from './tileMarker'

describe('3D tile markers', () => {
  it('marks white as 替 even if legacy state also lists it as a joker', () => {
    expect(tileMarkerFor('white', ['white'], [])).toBe('wildcard')
    expect(tileMarkerFor('white', [], ['white'])).toBe('wildcard')
  })

  it('keeps configured precision tiles marked as 精', () => {
    expect(tileMarkerFor('m5', ['m5'], ['white'])).toBe('joker')
  })

  it('does not mark an ordinary tile', () => {
    expect(tileMarkerFor('m5', [], ['white'])).toBe(false)
  })
})
