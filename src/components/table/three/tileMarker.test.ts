import { describe, expect, it } from 'vitest'
import { tileMarkerFor } from './tileMarker'

describe('3D tile markers', () => {
  it('marks white as 癞 when it is the ruleset joker (guangma white-joker)', () => {
    expect(tileMarkerFor('white', ['white'], [])).toBe('laizi')
  })

  it('marks white as 替 when listed as the legacy substitute tile', () => {
    expect(tileMarkerFor('white', [], ['white'])).toBe('wildcard')
    expect(tileMarkerFor('white', ['white'], ['white'])).toBe('wildcard')
  })

  it('does not mark white when it is not a joker or substitute', () => {
    expect(tileMarkerFor('white', [], [])).toBe(false)
  })

  it('keeps configured precision tiles marked as 精', () => {
    expect(tileMarkerFor('m5', ['m5'], ['white'])).toBe('joker')
  })

  it('does not mark an ordinary tile', () => {
    expect(tileMarkerFor('m5', [], ['white'])).toBe(false)
  })
})
