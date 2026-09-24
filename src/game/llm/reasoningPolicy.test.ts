import { describe, expect, it } from 'vitest'
import { inferLlmProviderType, PROVIDER_TEMPLATES, type LlmProviderConfig, type LlmProviderType } from './config'
import { dashScopeThinkingBody, inferProviderDialect, isDashScopeEndpoint, resolveReasoningPolicy } from './reasoningPolicy'

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
  })

  it.each([
    'qwen3-32b', 'qwen3-235b-a22b', 'qwen3-30b-a3b', 'qwen3-14b', 'qwen3-8b', 'qwen3-0.6b',
    'qwen3.8-27b', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-35b-a3b', 'qwen3.5-flash',
    'qwen3-max', 'qwen3-max-preview', 'qwen3.7-max-preview', 'qwen-max', 'qwen-plus',
    'qwen-flash', 'qwen-turbo', 'qwen-plus-2025-04-28',
  ])('混合思考的千问型号 %s 下发 enable_thinking=false（漏识别时正文会全空）', (model) => {
    expect(resolveReasoningPolicy(config('qwen', model))).toMatchObject({
      providerType: 'qwen', mode: 'explicit-off', requestBody: { enable_thinking: false },
    })
  })

  it.each(['qwen3-32b', 'qwen3-235b-a22b', 'qwen3.8-27b', 'qwen-max', 'qwen3-max'])(
    '千问开源尺寸与商业系列 %s 条件命中后仍可显式开启思考',
    (model) => {
      expect(resolveReasoningPolicy(config('qwen', model), true)).toMatchObject({
        providerType: 'qwen', mode: 'explicit-on', requestBody: { enable_thinking: true },
      })
    },
  )

  it.each([
    'qwen3-coder-plus', 'qwen3-coder-480b-a35b', 'qwen3-vl-plus', 'qwen2.5-vl-72b',
    'qwen3-omni-flash',
  ])('非思考千问型号 %s 保持普通请求，不附加思考参数', (model) => {
    expect(resolveReasoningPolicy(config('qwen', model))).toMatchObject({
      providerType: 'qwen', mode: 'naturally-off', requestBody: {},
    })
    expect(resolveReasoningPolicy(config('qwen', model), true).requestBody).toEqual({})
  })

  it.each([
    'qwen3.8-2.4t-a95b', 'qwen3-235b-a22b-thinking-2507',
    'qwen3-next-80b-a3b-thinking', 'qwq-plus',
  ])('纯思考千问型号 %s 只作识别，不当作可切换型号', (model) => {
    expect(resolveReasoningPolicy(config('qwen', model))).toMatchObject({
      providerType: 'qwen', mode: 'reasoning-only', requestBody: {},
    })
  })
  it('能力矩阵外的千问老型号不再误报为可切换，保持未知', () => {
    expect(resolveReasoningPolicy(config('qwen', 'qwen-long'))).toMatchObject({
      providerType: 'qwen', mode: 'unknown', requestBody: {},
    })
  })

  it('GLM-5.3 Flash 按官方与 OrcaRouter 方言分别选择疑难强度', () => {
    const official = { ...config('glm', 'glm-5.3-flash'), baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }
    const orca = { ...config('custom', 'z-ai/glm-5.3-flash'), baseUrl: 'https://api.orcarouter.ai/v1' }
    const relay = config('custom', 'z-ai/glm-5.3-flash')
    expect(resolveReasoningPolicy(official)).toMatchObject({ mode: 'always-on', requestBody: { reasoning_effort: 'low' } })
    expect(resolveReasoningPolicy(official, true).requestBody).toEqual({ reasoning_effort: 'high' })
    expect(resolveReasoningPolicy(orca, true).requestBody).toEqual({ reasoning_effort: 'medium' })
    expect(resolveReasoningPolicy(relay, true).requestBody).toEqual({ reasoning_effort: 'low' })
  })

  it('完整 GLM-5.3 官方使用 high，OrcaRouter 使用 medium', () => {
    const official = { ...config('glm', 'glm-5.3'), baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }
    const orca = { ...config('glm', 'z-ai/glm-5.3'), baseUrl: 'https://api.orcarouter.ai/v1' }
    expect(resolveReasoningPolicy(official)).toMatchObject({ mode: 'always-on', requestBody: { reasoning_effort: 'low' } })
    expect(resolveReasoningPolicy(official, true).requestBody).toEqual({ reasoning_effort: 'high' })
    expect(resolveReasoningPolicy(orca, true).requestBody).toEqual({ reasoning_effort: 'medium' })
  })

  it('识别官方、OrcaRouter 与未知兼容端点', () => {
    expect(inferProviderDialect('https://open.bigmodel.cn/api/paas/v4')).toBe('official')
    expect(inferProviderDialect('https://api.orcarouter.ai/v1')).toBe('orcarouter')
    expect(inferProviderDialect('https://proxy.example.com/v1')).toBe('compatible')
  })

  it('Kimi K3 经带前缀的中转模型 ID 使用普通 low、疑难 high 且不带采样参数', () => {
    expect(resolveReasoningPolicy(config('kimi', 'kimi/kimi-k3'))).toMatchObject({
      providerType: 'kimi', mode: 'always-on',
      requestBody: { reasoning_effort: 'low' },
    })
    expect(resolveReasoningPolicy(config('kimi', 'kimi/kimi-k3'), true).requestBody)
      .toEqual({ reasoning_effort: 'high' })
  })

  it('Claude Sonnet 5 默认思考必须显式关闭，条件命中时使用自适应思考', () => {
    const preset = config('custom', 'anthropic/claude-sonnet-5')
    expect(resolveReasoningPolicy(preset)).toMatchObject({
      providerType: 'claude', mode: 'explicit-off',
      requestBody: { thinking: { type: 'disabled' } },
    })
    expect(resolveReasoningPolicy(preset, true)).toMatchObject({
      providerType: 'claude', mode: 'explicit-on',
      requestBody: {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'medium' },
      },
    })
  })

  it.each(['kimi/kimi-k2.5', 'kimi/kimi-k2.6'])(
    'Kimi K2.5/K2.6 中转 ID %s 普通关闭、条件触发后开启',
    (model) => {
      const preset = config('kimi', model)
      expect(resolveReasoningPolicy(preset)).toMatchObject({
        providerType: 'kimi', mode: 'explicit-off',
        acceptReasoningResponse: true,
        requestBody: {
          thinking: { type: 'disabled' }, temperature: 0.6, top_p: 0.95,
        },
      })
      expect(resolveReasoningPolicy(preset, true)).toMatchObject({
        providerType: 'kimi', mode: 'explicit-on',
        requestBody: {
          thinking: { type: 'enabled' }, temperature: 1, top_p: 0.95,
        },
      })
    },
  )

  it.each(['kimi/kimi-k2', 'moonshot-v1-128k'])(
    'Kimi K2 基础版与 Moonshot v1 旧型号 %s 保持普通非思考请求',
    (model) => {
      expect(resolveReasoningPolicy(config('kimi', model))).toMatchObject({
        providerType: 'kimi', mode: 'naturally-off', requestBody: {},
      })
      expect(resolveReasoningPolicy(config('kimi', model), true)).toMatchObject({
        providerType: 'kimi', mode: 'naturally-off', requestBody: {},
      })
    },
  )

  it('未列入能力矩阵的 Kimi 旧型号保守保持未知，不乱传思考参数', () => {
    expect(resolveReasoningPolicy(config('kimi', 'kimi-legacy-custom'))).toMatchObject({
      providerType: 'kimi', mode: 'unknown', requestBody: {},
    })
  })

  it('千问预置（含开源尺寸）都在能力矩阵内，预置不会重现空正文故障', () => {
    const qwenTemplates = PROVIDER_TEMPLATES.filter((template) => template.providerType === 'qwen')
    expect(qwenTemplates).toContainEqual(expect.objectContaining({ model: 'qwen3-32b' }))
    for (const template of qwenTemplates) {
      expect(resolveReasoningPolicy({
        baseUrl: template.baseUrl, model: template.model, providerType: template.providerType,
      })).toMatchObject({ mode: 'explicit-off', requestBody: { enable_thinking: false } })
    }
  })

  it('GLM 新增预设只推荐官方端点，不再推荐行为异常的 OrcaRouter 型号', () => {
    expect(PROVIDER_TEMPLATES).toContainEqual(expect.objectContaining({
      providerType: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash',
    }))
    expect(PROVIDER_TEMPLATES).not.toContainEqual(expect.objectContaining({
      providerType: 'glm', baseUrl: 'https://api.orcarouter.ai/v1', model: 'z-ai/glm-5.3-flash',
    }))
  })

  it('Kimi 新增预设只提供官方 Moonshot，不推荐 OrcaRouter', () => {
    expect(PROVIDER_TEMPLATES).toContainEqual(expect.objectContaining({
      providerType: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6',
    }))
    expect(PROVIDER_TEMPLATES).not.toContainEqual(expect.objectContaining({
      providerType: 'kimi', baseUrl: 'https://api.orcarouter.ai/v1',
    }))
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

  it('DashScope 上的别家模型按型号识别，不被地址带成千问', () => {
    const dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    expect(inferLlmProviderType(dash, 'glm-4.7')).toBe('glm')
    expect(inferLlmProviderType(dash, 'kimi-k2.6')).toBe('kimi')
    expect(inferLlmProviderType(dash, 'deepseek-v4-flash')).toBe('deepseek')
    expect(inferLlmProviderType(dash, 'qwen3-32b')).toBe('qwen')
    // 型号无名厂指纹时仍按地址兜底成千问
    expect(inferLlmProviderType(dash, 'some-new-model')).toBe('qwen')
  })

  it('DashScope 上改用统一开关 enable_thinking（各家原生参数实测无效）', () => {
    const dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    const glm = { baseUrl: dash, model: 'glm-4.7', providerType: 'glm' as const }
    expect(resolveReasoningPolicy(glm).mode).toBe('explicit-off')
    expect(dashScopeThinkingBody(resolveReasoningPolicy(glm).mode)).toEqual({ enable_thinking: false })
    expect(dashScopeThinkingBody(resolveReasoningPolicy(glm, true).mode)).toEqual({ enable_thinking: true })
    // 原生端点仍保留各家方言
    const nativeGlm = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7', providerType: 'glm' as const }
    expect(resolveReasoningPolicy(nativeGlm).requestBody).toEqual({ thinking: { type: 'disabled' } })
    expect(isDashScopeEndpoint(nativeGlm.baseUrl)).toBe(false)
    expect(isDashScopeEndpoint(dash)).toBe(true)
    // token-plan 是百炼的另一个接入点，同样按 DashScope 处理
    expect(isDashScopeEndpoint('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')).toBe(true)
  })
})


describe('截图中百炼托管型号', () => {
  const dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const hosted = (model: string) => ({ baseUrl: dash, model, providerType: 'qwen' as const })

  it.each(['glm-4.5v', 'glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx'])(
    '%s 即使沿用千问预置也按可切换的 GLM 视觉模型处理', (model) => {
      const quick = resolveReasoningPolicy(hosted(model))
      const deep = resolveReasoningPolicy(hosted(model), true)
      expect(quick).toMatchObject({ providerType: 'glm', mode: 'explicit-off' })
      expect(deep).toMatchObject({ providerType: 'glm', mode: 'explicit-on' })
      expect(dashScopeThinkingBody(quick.mode)).toEqual({ enable_thinking: false })
      expect(dashScopeThinkingBody(deep.mode)).toEqual({ enable_thinking: true })
    },
  )

  it('自定义百炼 GLM-5 普通出牌关闭思考，疑难决策仍开启高强度', () => {
    const hosted = {
      baseUrl: 'https://example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'glm-5', providerType: 'custom' as const,
    }
    const quick = resolveReasoningPolicy(hosted)
    const deep = resolveReasoningPolicy(hosted, true)
    expect(quick).toMatchObject({ providerType: 'glm', mode: 'explicit-off', requestBody: {} })
    expect(deep).toMatchObject({ providerType: 'glm', mode: 'explicit-on', requestBody: { reasoning_effort: 'high' } })
    expect(dashScopeThinkingBody(quick.mode)).toEqual({ enable_thinking: false })
    expect(dashScopeThinkingBody(deep.mode)).toEqual({ enable_thinking: true })
  })

  it.each(['glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'])(
    '%s 普通低强度，条件触发后提高到 high', (model) => {
      const quick = resolveReasoningPolicy(hosted(model))
      const deep = resolveReasoningPolicy(hosted(model), true)
      expect(quick).toMatchObject({ providerType: 'glm', requestBody: { reasoning_effort: 'low' } })
      expect(deep).toMatchObject({ providerType: 'glm', requestBody: { reasoning_effort: 'high' } })
      expect(dashScopeThinkingBody(quick.mode)).toEqual({ enable_thinking: true })
      expect(dashScopeThinkingBody(deep.mode)).toEqual({ enable_thinking: true })
    },
  )

  it.each(['deepseek-v4-flash-0731', 'deepseek-v4-pro-0813'])(
    '%s 使用支持的 low/high 强度，不误判为千问', (model) => {
      expect(resolveReasoningPolicy(hosted(model))).toMatchObject({
        providerType: 'deepseek', mode: 'explicit-on', requestBody: { reasoning_effort: 'low' },
      })
      expect(resolveReasoningPolicy(hosted(model), true)).toMatchObject({
        providerType: 'deepseek', mode: 'explicit-on', requestBody: { reasoning_effort: 'high' },
      })
    },
  )

  it('不支持 low 的托管型号保持可调用，不发送无效强度', () => {
    expect(resolveReasoningPolicy(hosted('deepseek-r1'))).toMatchObject({
      providerType: 'deepseek', mode: 'reasoning-only', requestBody: {},
    })
    expect(resolveReasoningPolicy(hosted('kimi-k3'))).toMatchObject({
      providerType: 'kimi', mode: 'always-on', requestBody: {},
    })
    expect(resolveReasoningPolicy(hosted('kimi-k2.7-code'))).toMatchObject({
      providerType: 'kimi', mode: 'reasoning-only', requestBody: {},
    })
    expect(resolveReasoningPolicy(hosted('kimi-k2-thinking'))).toMatchObject({
      providerType: 'kimi', mode: 'reasoning-only', requestBody: {},
    })
    expect(resolveReasoningPolicy(hosted('Moonshot-Kimi-K2-Instruct'))).toMatchObject({
      providerType: 'kimi', mode: 'naturally-off', requestBody: {},
    })
  })

  it('识别百炼业务空间和自己的 token-plan 透传地址', () => {
    const maas = 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
    const relay = 'https://www.bestguo.top:58000/api/llm/relay/token-plan'
    expect(isDashScopeEndpoint(maas)).toBe(true)
    expect(isDashScopeEndpoint(relay)).toBe(true)
    expect(inferProviderDialect(maas)).toBe('official')
  })
})


describe('截图所有型号的快速模式', () => {
  const dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  it.each([
    ['glm-5', 'glm', 'explicit-off'], ['glm-4.5-air', 'glm', 'explicit-off'],
    ['glm-5.1', 'glm', 'explicit-on'], ['glm-5.2', 'glm', 'explicit-on'],
    ['glm-5.3', 'glm', 'always-on'], ['glm-4.5', 'glm', 'explicit-off'],
    ['glm-4.6', 'glm', 'explicit-off'], ['glm-4.7', 'glm', 'explicit-off'],
    ['deepseek-r1-distill-qwen-7b', 'deepseek', 'reasoning-only'],
    ['deepseek-r1-distill-qwen-32b', 'deepseek', 'reasoning-only'],
    ['deepseek-v4-flash-0731', 'deepseek', 'explicit-on'],
    ['deepseek-r1', 'deepseek', 'reasoning-only'],
    ['deepseek-v4-pro', 'deepseek', 'explicit-off'],
    ['deepseek-r1-distill-qwen-14b', 'deepseek', 'reasoning-only'],
    ['deepseek-v4-pro-0813', 'deepseek', 'explicit-on'],
    ['deepseek-v3.1', 'deepseek', 'explicit-off'],
    ['deepseek-v3.2', 'deepseek', 'explicit-off'],
    ['deepseek-v4-flash', 'deepseek', 'explicit-off'],
    ['kimi-k2.5', 'kimi', 'explicit-off'],
    ['kimi-k2-thinking', 'kimi', 'reasoning-only'],
    ['kimi-k2.7-code', 'kimi', 'reasoning-only'],
    ['Moonshot-Kimi-K2-Instruct', 'kimi', 'naturally-off'],
    ['kimi-k3', 'kimi', 'always-on'],
    ['MiniMax-M2.5', 'minimax', 'reasoning-only'],
    ['MiniMax-M2.1', 'minimax', 'reasoning-only'],
  ] as const)('%s uses %s / %s', (model, providerType, mode) => {
    expect(resolveReasoningPolicy({ providerType: 'qwen', baseUrl: dash, model }))
      .toMatchObject({ providerType, mode })
  })

  it.each(['glm-4.5v', 'glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx'])(
    '%s on the official Z.ai endpoint sends its native thinking toggle', (model) => {
      const config = { providerType: 'glm' as const, baseUrl: 'https://api.z.ai/api/paas/v4', model }
      expect(resolveReasoningPolicy(config).requestBody).toEqual({ thinking: { type: 'disabled' } })
      expect(resolveReasoningPolicy(config, true).requestBody).toEqual({ thinking: { type: 'enabled' } })
    },
  )
})
