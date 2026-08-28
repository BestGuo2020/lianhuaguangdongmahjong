import { describe, expect, it } from 'vitest'
import { inferLlmProviderType, PROVIDER_TEMPLATES, type LlmProviderConfig, type LlmProviderType } from './config'
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

  it('GLM-5.3 Flash 经自定义中转自动识别，固定使用最低思考强度', () => {
    const result = resolveReasoningPolicy(config('custom', 'z-ai/glm-5.3-flash'))
    expect(result).toMatchObject({
      providerType: 'glm', mode: 'always-on',
      requestBody: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
    })
    expect(resolveReasoningPolicy(config('custom', 'z-ai/glm-5.3-flash'), true).requestBody)
      .toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'low' })
  })

  it('Kimi K3 经带前缀的中转模型 ID 自动使用固定采样参数', () => {
    expect(resolveReasoningPolicy(config('kimi', 'kimi/kimi-k3'))).toMatchObject({
      providerType: 'kimi', mode: 'always-on',
      requestBody: { temperature: 1, top_p: 0.95 },
    })
  })

  it.each(['kimi/kimi-k2.5', 'kimi/kimi-k2.6'])(
    'Kimi K2.5/K2.6 中转 ID %s 保持可关闭思考模式',
    (model) => {
      expect(resolveReasoningPolicy(config('kimi', model))).toMatchObject({
        providerType: 'kimi', mode: 'explicit-off',
        requestBody: {
          thinking: { type: 'disabled' }, temperature: 0.6, top_p: 0.95,
        },
      })
    },
  )

  it('Kimi K2 基础/预览系列保持普通非思考请求', () => {
    expect(resolveReasoningPolicy(config('kimi', 'kimi/kimi-k2'))).toMatchObject({
      providerType: 'kimi', mode: 'naturally-off', requestBody: {},
    })
  })

  it('GLM 预设同时提供官方端点和 OrcaRouter 兼容中转', () => {
    expect(PROVIDER_TEMPLATES).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerType: 'glm', model: 'glm-5.3-flash' }),
      {
        name: 'GLM 5.3 Flash (OrcaRouter)', providerType: 'glm',
        baseUrl: 'https://api.orcarouter.ai/v1', model: 'z-ai/glm-5.3-flash',
      },
    ]))
  })

  it('Kimi 预设提供 OrcaRouter K3 完整模型 ID', () => {
    expect(PROVIDER_TEMPLATES).toContainEqual({
      name: 'Kimi K2.6 (OrcaRouter)', providerType: 'kimi',
      baseUrl: 'https://api.orcarouter.ai/v1', model: 'kimi/kimi-k2.6',
    })
    expect(PROVIDER_TEMPLATES).toContainEqual({
      name: 'Kimi K3 (OrcaRouter)', providerType: 'kimi',
      baseUrl: 'https://api.orcarouter.ai/v1', model: 'kimi/kimi-k3',
    })
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
