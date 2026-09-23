import { LLM_DECISION_TIMEOUT_MS, type LlmSettings } from '../../llm/config'
import { LOTUS_RULESET } from '../../variants/lotus/lotusRules'
import type { AnalysisModelConfig } from './types'
import { localAnalysisModels } from './localAnalysisModels'

/** Serializable rules and effective local AI settings for the flip-joker variant. */
export function lotusLegacyAnalysisConfig(settings: LlmSettings, llmEnabled: boolean): {
  rules: Record<string, unknown>
  rulesVersion: string
  aiStrategy: string
  aiConfig: Record<string, unknown>
  models: AnalysisModelConfig[]
} {
  const { seats, models } = localAnalysisModels(settings, llmEnabled)
  return {
    rulesVersion: LOTUS_RULESET.id,
    rules: {
      id: LOTUS_RULESET.id,
      baseScore: LOTUS_RULESET.baseScore,
      flow: { ...LOTUS_RULESET.flow },
      jokerRule: 'flip-indicator-and-next',
      whiteTileSubstitute: 'flip-joker-or-white',
      chi: ['sequence', 'wind', 'dragon'],
      winPatterns: { ordinary: 1, sevenPairs: 2, shiSanLan: 2, qiXing: 4, thirteenOrphans: 8, tianhu: 10, dihu: 10 },
      dealerMultiplier: 2,
    },
    aiStrategy: llmEnabled ? 'LotusLlmController' : 'LotusAiController',
    aiConfig: {
      controller: llmEnabled ? 'LotusLlmController' : 'LotusAiController',
      fallback: llmEnabled ? 'LotusAiController' : null,
      decisionTimeoutMs: llmEnabled ? LLM_DECISION_TIMEOUT_MS : null,
      seats,
    },
    models,
  }
}
