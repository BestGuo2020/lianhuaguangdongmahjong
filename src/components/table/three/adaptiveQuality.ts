export const QUALITY_LEVELS = [
  { glossy: true, shadowSize: 1024 },
  { glossy: true, shadowSize: 512 },
  { glossy: false, shadowSize: 512 },
] as const

interface AdaptiveQualityOptions {
  override?: number | null
  warmupFrames?: number
  downgradeFrameMs?: number
  upgradeFrameMs?: number
  downgradeFrames?: number
  upgradeFrames?: number
  onChange(level: number): void
}

export function parseQualityOverride(search: string) {
  const raw = new URLSearchParams(search).get('q')
  if (raw == null || raw === '') return null
  const level = Number.parseInt(raw, 10)
  return Number.isFinite(level) && level >= 0 && level < QUALITY_LEVELS.length ? level : null
}

export function createAdaptiveQualityController({
  override = null,
  warmupFrames = 10,
  downgradeFrameMs = 26,
  upgradeFrameMs = 20,
  downgradeFrames = 45,
  upgradeFrames = 180,
  onChange,
}: AdaptiveQualityOptions) {
  let level = override ?? 0
  let emaFrameMs = 0
  let badFrames = 0
  let goodFrames = 0
  let warmup = warmupFrames

  function apply() {
    onChange(level)
  }

  function frame(frameMs: number) {
    if (override !== null) return
    if (warmup > 0) {
      warmup -= 1
      emaFrameMs = 0
      return
    }
    if (frameMs <= 0) return
    emaFrameMs = emaFrameMs ? emaFrameMs * .92 + frameMs * .08 : frameMs
    if (emaFrameMs > downgradeFrameMs) {
      badFrames += 1
      goodFrames = 0
      if (badFrames >= downgradeFrames && level < QUALITY_LEVELS.length - 1) {
        level += 1
        badFrames = 0
        apply()
      }
    } else if (emaFrameMs < upgradeFrameMs) {
      goodFrames += 1
      badFrames = 0
      if (goodFrames >= upgradeFrames && level > 0) {
        level -= 1
        goodFrames = 0
        apply()
      }
    } else {
      badFrames = 0
      goodFrames = 0
    }
  }

  return {
    frame,
    apply,
    get level() { return level },
    get overridden() { return override !== null },
  }
}
