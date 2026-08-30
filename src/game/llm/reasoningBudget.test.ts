import { beforeEach, describe, expect, it } from 'vitest'
import type { LlmProviderConfig } from './config'
import {
  adaptiveReasoningBudget, isReasoningTemporarilySuppressed,
  recordReasoningLength, recordReasoningSuccess, resetReasoningBudgetForTests,
} from './reasoningBudget'
import { resolveReasoningPolicy } from './reasoningPolicy'

const config: LlmProviderConfig = {
  providerType: 'deepseek', baseUrl: 'https://api.orcarouter.ai/v1',
  apiKey: 'sk', model: 'deepseek/deepseek-v4-flash', style: '稳健', timeoutMs: 40_000,
}

describe('自适应推理预算', () => {
  beforeEach(resetReasoningBudgetForTests)

  it('首请求沿用初始上限，成功后按 P99 reasoning + 96 向上取整', () => {
    const policy = resolveReasoningPolicy(config, true)
    expect(adaptiveReasoningBudget(config, policy, 65_536)).toBe(65_536)
    recordReasoningSuccess(config, policy, 1_000)
    expect(adaptiveReasoningBudget(config, policy, 65_536)).toBe(2_048)
  })

  it('截断后下一次预算至少翻倍且不超过 65536', () => {
    const policy = resolveReasoningPolicy(config, true)
    recordReasoningLength(config, policy, 2_048, 2_000)
    expect(adaptiveReasoningBudget(config, policy, 512)).toBe(4_096)
    recordReasoningLength(config, policy, 40_000, 39_900)
    expect(adaptiveReasoningBudget(config, policy, 512)).toBe(65_536)
  })

  it('连续两次满额截断后临时停用条件深思，成功会解除', () => {
    const policy = resolveReasoningPolicy(config, true)
    recordReasoningLength(config, policy, 65_536, 65_536)
    expect(isReasoningTemporarilySuppressed(config, policy)).toBe(false)
    recordReasoningLength(config, policy, 65_536, 65_536)
    expect(isReasoningTemporarilySuppressed(config, policy)).toBe(true)
    recordReasoningSuccess(config, policy, 1_000)
    expect(isReasoningTemporarilySuppressed(config, policy)).toBe(false)
  })
})
