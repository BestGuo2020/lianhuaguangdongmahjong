import { afterEach, expect, it, vi } from 'vitest'
import { createEvaluatorService } from './evaluatorService'
import type { WinEvaluationInput } from '../bloodFlow/types'

afterEach(() => vi.unstubAllGlobals())
it('correlates out-of-order results and rejects all work on termination', async () => {
  const fake = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null as any, onerror: null as any }
  vi.stubGlobal('Worker', class { constructor() { return fake } })
  const service = createEvaluatorService()
  const input: WinEvaluationInput = { concealed: [], melds: [], winningTile: 'east', jokers: [], source: 'discard', opening: null }
  const first = service.evaluate(input)
  const second = service.evaluate(input)
  fake.onmessage({ data: { id: 2, result: null } })
  await expect(second).resolves.toBeNull()
  const cancelled = expect(first).rejects.toThrow('Evaluation cancelled')
  service.cancel()
  await cancelled
  expect(fake.terminate).toHaveBeenCalledOnce()
  fake.onmessage({ data: { id: 1, result: { partial: true } } })
  await expect(service.evaluate(input)).rejects.toThrow('Evaluator stopped')
})
