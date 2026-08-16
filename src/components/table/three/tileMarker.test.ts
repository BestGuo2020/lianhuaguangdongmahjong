import { describe, expect, it } from 'vitest'
import { tileMarkerFor } from './tileMarker'

describe('3D tile markers', () => {
  it('marks white as 精 when white itself is a joker (white flipped jing)', () => {
    // 白板翻精：白板同时在精集合（[白板, 红中]）与替身集合 → 标精（可替代任意牌）
    expect(tileMarkerFor('white', ['white', 'red'], ['white'])).toBe('joker')
  })

  it('marks white as 替 when listed only as the legacy substitute tile', () => {
    // 翻到非白板（如 3 万）：白板只是替身，只能替代精牌面 → 标替
    expect(tileMarkerFor('white', [], ['white'])).toBe('wildcard')
    expect(tileMarkerFor('white', ['m3', 'm4'], ['white'])).toBe('wildcard')
  })

  it('marks white as 癞 when it is the guangma white-joker (joker only)', () => {
    expect(tileMarkerFor('white', ['white'], [])).toBe('laizi')
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
