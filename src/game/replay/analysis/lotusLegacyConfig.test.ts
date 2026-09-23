import { expect, it } from 'vitest'
import { emptyLlmSettings } from '../../llm/config'
import { lotusLegacyAnalysisConfig } from './lotusLegacyConfig'

it('records flip-joker rules and a truthful local controller without credentials', () => {
  const snapshot = lotusLegacyAnalysisConfig(emptyLlmSettings(), false)
  expect(snapshot.rules).toMatchObject({ id: 'lotus-legacy', jokerRule: 'flip-indicator-and-next' })
  expect(snapshot.aiStrategy).toBe('LotusAiController')
  expect(snapshot.aiConfig).toMatchObject({ controller: 'LotusAiController', seats: [] })
  expect(snapshot.models).toEqual([])
})
