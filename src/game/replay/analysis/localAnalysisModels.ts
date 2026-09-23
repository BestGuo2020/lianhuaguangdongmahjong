import { presetForSeat, styleForSeat, type LlmSettings } from '../../llm/config'
import type { AnalysisModelConfig } from './types'
import { UNKNOWN } from './types'

/** Match the local controller factory's per-seat selection without exporting keys or URLs. */
export function localAnalysisModels(settings: LlmSettings, llmEnabled: boolean) {
  const seats = llmEnabled ? ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    if (!preset) return null
    return {
      seat,
      provider: preset.providerType ?? 'unknown',
      requestModel: preset.model,
      style: styleForSeat(settings, seat) ?? preset.style,
      timeoutEnabled: preset.timeoutEnabled !== false,
    }
  }).filter((item): item is NonNullable<typeof item> => item !== null) : []
  const models: AnalysisModelConfig[] = seats.map(({ seat, provider, requestModel }) => ({
    seat, provider, requestModel, responseModel: UNKNOWN, sampling: {},
  }))
  return { seats, models }
}
