import { expect, it } from 'vitest'
import { lotusClassicAnalysisConfig } from './lotusClassicConfig'
import type { LlmSettings } from '../../llm/config'

it('captures the active classic rules and per-seat models without credentials', () => {
  const settings: LlmSettings = {
    enabled: true,
    presets: [{
      id: 'p1', name: 'example', providerType: 'custom', baseUrl: 'https://example.test/v1',
      apiKey: 'secret-key-must-not-export', model: 'example-model', style: '稳健',
      timeoutMs: 9_999, timeoutEnabled: false,
    }],
    activeId: 'p1', seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
  }
  const snapshot = lotusClassicAnalysisConfig(settings, true)
  expect(snapshot.rules).toMatchObject({ id: 'lotus-classic', baseScore: 100, jokerTile: 'white', horseDrawCount: 8 })
  expect(snapshot.aiStrategy).toBe('CoreLlmController')
  expect(snapshot.models.map((model) => [model.seat, model.requestModel])).toEqual([
    [1, 'example-model'], [2, 'example-model'], [3, 'example-model'],
  ])
  expect(snapshot.aiConfig).toMatchObject({ decisionTimeoutMs: 40_000, seats: [
    { seat: 1, style: '稳健', timeoutEnabled: false },
    { seat: 2, style: '稳健', timeoutEnabled: false },
    { seat: 3, style: '稳健', timeoutEnabled: false },
  ] })
  expect(JSON.stringify(snapshot)).not.toContain('secret-key-must-not-export')
  expect(JSON.stringify(snapshot)).not.toContain('example.test')
})
