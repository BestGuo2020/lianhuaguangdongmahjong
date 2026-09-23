import { LLM_DECISION_TIMEOUT_MS, type LlmSettings } from '../../llm/config'
import { CLASSIC_RULESET } from '../../core/rules/rules'
import type { AnalysisModelConfig } from './types'
import { localAnalysisModels } from './localAnalysisModels'

/** A serializable snapshot of the local classic rules and active AI settings. */
export function lotusClassicAnalysisConfig(settings: LlmSettings, llmEnabled: boolean): {
  rules: Record<string, unknown>
  rulesVersion: string
  aiStrategy: string
  aiConfig: Record<string, unknown>
  models: AnalysisModelConfig[]
} {
  const { seats, models } = localAnalysisModels(settings, llmEnabled)
  return {
    rulesVersion: CLASSIC_RULESET.id,
    rules: {
      id: CLASSIC_RULESET.id,
      baseScore: CLASSIC_RULESET.baseScore,
      flow: { ...CLASSIC_RULESET.flow },
      jokerTile: 'white',
      redTileReplacement: 'tail-draw',
      winMethods: ['self-draw', 'robbed-kong'],
      horseDrawCount: 8,
      multipliers: { dealer: 2, noJoker: 2, kongBloom: 2, fourRed: 4 },
    },
    aiStrategy: llmEnabled ? 'CoreLlmController' : 'AiController',
    aiConfig: {
      controller: llmEnabled ? 'CoreLlmController' : 'AiController',
      fallback: llmEnabled ? 'AiController' : null,
      decisionTimeoutMs: llmEnabled ? LLM_DECISION_TIMEOUT_MS : null,
      seats,
    },
    models,
  }
}
