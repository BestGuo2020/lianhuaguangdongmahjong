import { expect, it } from 'vitest'
import { createAnalysisRecorder } from './recorder'
import { createAnalysisMemoryStorage } from './storage'
import { createLotusClassicDecisionSink } from './lotusClassicDecisionSink'
import type { AnalysisDecision, AnalysisLlmAttempt } from './types'

it('correlates a classic model request with the engine window and its actual choice', async () => {
  const storage = createAnalysisMemoryStorage()
  const recorder = createAnalysisRecorder({ enabled: true, matchId: 'classic-sink', rulesetId: 'lotus-classic', storage })
  recorder.beginMatch({
    engineBuild: 'test', rulesVersion: 'lotus-classic', rulesFingerprint: 'rules', rules: { id: 'lotus-classic' },
    aiStrategy: 'CoreLlmController', aiFingerprint: 'ai', aiConfig: {}, seatControl: ['human', 'llm', 'local-ai', 'local-ai'],
  })
  const sink = createLotusClassicDecisionSink({ recorder })
  const windowId = '1/window/2'
  const legal = [{ id: `${windowId}/0`, kind: 'discard', tile: 'm1', handIndex: 0 }]
  recorder.windowOpened({
    windowId, seat: 1, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'local', stateVersion: 2,
    state: { id: `${windowId}/1`, legalActions: legal },
  })
  sink.windowOpened({ seat: 1, windowId, legalActions: legal })
  sink.hooks.onDecisionRequest({
    seat: 1, requestId: 'raw-request-7', windowId: 'raw-request-7',
    legalActions: [{ id: 'raw-request-7/0', kind: 'discard', tile: 'm1', handIndex: 0 }],
    candidates: [{ id: 'raw-request-7/0', summary: 'A1', action: { kind: 'discard', handIndex: 0 } }],
    recommended: { candidateId: 'raw-request-7/0' },
    promptTemplateId: 'classic-prompt/1', promptVariables: { system: 'system', user: 'choose A1' },
    provider: 'test', model: 'model-1', sentAt: 1,
  })
  sink.hooks.onDecisionAnswer({ requestId: 'raw-request-7', raw: 'A1', choice: 'A1', outcome: 'success', completedAt: 2 })
  sink.windowClosed(1)
  recorder.chosen({ windowId, seat: 1, legalActionId: `${windowId}/0`, source: 'unknown' })
  await recorder.finish()

  const parts = (await storage.read('classic-sink')).parts
  const decision = parts.filter((part) => part.tag === 'decision').at(-1)?.value as AnalysisDecision
  const attempt = parts.find((part) => part.tag === 'llm')?.value as AnalysisLlmAttempt
  expect(decision.source).toBe('model')
  expect(decision.choice).toMatchObject({ known: true, value: { legalActionId: `${windowId}/0` } })
  expect(decision.candidates?.map((candidate) => candidate.legalActionId)).toEqual([`${windowId}/0`])
  expect(decision.recommended).toMatchObject({ known: true, value: { legalActionId: `${windowId}/0` } })
  expect(decision.llmAttemptIds).toEqual([attempt.id])
  expect(attempt.decisionId).toBe(decision.id)
  expect(attempt.promptVariables?.user).toBe('choose A1')
})
