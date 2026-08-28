import { describe, expect, it } from 'vitest'
import { inferLlmProviderType, type LlmProviderConfig, type LlmProviderType } from './config'
import { resolveReasoningPolicy } from './reasoningPolicy'

function config(providerType: LlmProviderType, model: string): LlmProviderConfig {
  return {
    providerType, model, baseUrl: 'https://proxy.example.com/v1', apiKey: 'sk-test',
    style: '稳健', timeoutMs: 20_000,
  }
}

describe('LLM 非思考能力矩阵', () => {
  it.each([
    ['deepseek', 'deepseek-v4-flash', { thinking: { type: 'disabled' } }],
    ['qwen', 'qwen3.7-plus', { enable_thinking: false }],
    ['kimi', 'kimi-k2.6', { thinking: { type: 'disabled' }, temperature: 0.6, top_p: 0.95 }],
    ['doubao', 'doubao-1.5-thinking-pro', { thinking: { type: 'disabled' } }],
    ['openai', 'gpt-5.6', { reasoning_effort: 'none' }],
    ['glm', 'glm-4.7-flash', { thinking: { type: 'disabled' } }],
  ] as const)('%s 手动换成 %s 后强制关闭思考', (providerType, model, requestBody) => {
    const result = resolveReasoningPolicy(config(providerType, model))
    expect(result.mode).toBe('explicit-off')
    expect(result.requestBody).toEqual(requestBody)
  })

  it.each([
    ['deepseek', 'deepseek-reasoner'], ['qwen', 'qwq-plus'], ['kimi', 'kimi-k2-thinking'],
    ['minimax', 'MiniMax-M2.7'], ['openai', 'o3-mini'], ['glm', 'glm-4.1v-thinking-flash'],
  ] as Array<[LlmProviderType, string]>)('%s 推理专用模型 %s 只作识别不预检', (providerType, model) => {
    const result = resolveReasoningPolicy(config(providerType, model))
    expect(result.mode).toBe('reasoning-only')
    expect(result.requestBody).toEqual({})
  })

  it('未知自定义代理与未知型号不附加供应商参数', () => {
    expect(resolveReasoningPolicy(config('custom', 'mystery-model')).mode).toBe('unknown')
    expect(resolveReasoningPolicy(config('qwen', 'qwen3.7-plus')).mode).toBe('explicit-off')
    expect(resolveReasoningPolicy(config('qwen', 'qwen-plus'))).toMatchObject({ mode: 'unknown', requestBody: {} })
  })

  it.each([
    ['deepseek', 'deepseek-v4-flash', { thinking: { type: 'enabled' }, reasoning_effort: 'medium' }],
    ['qwen', 'qwen3.8-flash', { enable_thinking: true }],
    ['openai', 'gpt-5.6-sol', { reasoning_effort: 'medium' }],
  ] as const)('%s 条件命中时显式开启思考且不改变模型', (providerType, model, requestBody) => {
    const result = resolveReasoningPolicy(config(providerType, model), true)
    expect(result.mode).toBe('explicit-on')
    expect(result.requestBody).toEqual(requestBody)
  })

  it('旧配置可从官方地址或模型名迁移供应商类型', () => {
    expect(inferLlmProviderType('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus')).toBe('qwen')
    expect(inferLlmProviderType('https://proxy.local/v1', 'kimi-k2.6')).toBe('kimi')
    expect(inferLlmProviderType('https://api.example.com/v1', 'mystery-model')).toBe('custom')
  })
})
