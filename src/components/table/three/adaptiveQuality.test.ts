import { describe, expect, it, vi } from 'vitest'
import { createAdaptiveQualityController, parseQualityOverride } from './adaptiveQuality'

describe('adaptiveQuality', () => {
  it('parses only supported forced quality levels', () => {
    expect(parseQualityOverride('?q=2')).toBe(2)
    expect(parseQualityOverride('?q=3')).toBeNull()
    expect(parseQualityOverride('?q=bad')).toBeNull()
  })

  it('downgrades and upgrades after sustained frame pressure', () => {
    const onChange = vi.fn()
    const quality = createAdaptiveQualityController({
      warmupFrames: 0,
      downgradeFrames: 2,
      upgradeFrames: 2,
      onChange,
    })
    quality.frame(40)
    quality.frame(40)
    expect(quality.level).toBe(1)
    for (let index = 0; index < 100; index += 1) quality.frame(1)
    expect(quality.level).toBe(0)
    expect(onChange).toHaveBeenCalled()
  })

  it('keeps a forced level fixed', () => {
    const onChange = vi.fn()
    const quality = createAdaptiveQualityController({ override: 2, warmupFrames: 0, downgradeFrames: 1, onChange })
    quality.apply()
    quality.frame(100)
    expect(quality.level).toBe(2)
    expect(onChange).toHaveBeenCalledOnce()
  })
})
