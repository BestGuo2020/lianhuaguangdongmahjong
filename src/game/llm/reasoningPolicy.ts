import { inferLlmProviderType, type LlmProviderConfig, type LlmProviderType } from './config'

export type ReasoningPolicyMode = 'explicit-off' | 'explicit-on' | 'always-on' | 'naturally-off' | 'reasoning-only' | 'unknown'

export interface ReasoningPolicy {
  providerType: LlmProviderType
  mode: ReasoningPolicyMode
  requestBody: Record<string, unknown>
  message: string
  /** 已要求关闭思考，但部分中转仍会返回推理字段；有最终 content 时可继续解析。 */
  acceptReasoningResponse: boolean
}

function policy(
  providerType: LlmProviderType,
  mode: ReasoningPolicyMode,
  message: string,
  requestBody: Record<string, unknown> = {},
  acceptReasoningResponse = false,
): ReasoningPolicy {
  return { providerType, mode, requestBody, message, acceptReasoningResponse }
}

/**
 * 将供应商协议和用户手填模型解析成最佳努力的非思考策略。
 * 型号识别只用于附加已知参数；未知、推理专用和自定义模型不在客户端拦截。
 */
export function resolveReasoningPolicy(
  config: Pick<LlmProviderConfig, 'baseUrl' | 'model' | 'providerType'>,
  reasoning = false,
): ReasoningPolicy {
  const inferredProviderType = inferLlmProviderType(config.baseUrl, config.model)
  // 「自定义」只代表 OpenAI 兼容传输；仍可按完整模型 ID 追加已知厂商参数。
  const providerType = !config.providerType || config.providerType === 'custom'
    ? inferredProviderType
    : config.providerType
  const qualifiedModel = config.model.trim().toLowerCase()
  const model = qualifiedModel.slice(qualifiedModel.lastIndexOf('/') + 1)

  switch (providerType) {
    case 'deepseek':
      if (/(?:reasoner|(^|[-_.])r1(?:[-_.]|$))/.test(model)) {
        return policy(providerType, 'reasoning-only', 'DeepSeek Reasoner/R1 属于推理专用模型，无法保证关闭思考')
      }
      return reasoning
        ? policy(providerType, 'explicit-on', '已开启 DeepSeek 条件思考', {
          thinking: { type: 'enabled' }, reasoning_effort: 'medium',
        })
        : policy(providerType, 'explicit-off', '已强制关闭 DeepSeek 思考模式', {
          thinking: { type: 'disabled' },
        })
    case 'qwen':
      if (/^(?:qwq|.*thinking)/.test(model)) {
        return policy(providerType, 'reasoning-only', '该千问型号属于推理专用模型，无法关闭思考')
      }
      if (/^qwen-?3\.(?:5|6|7|8)(?:[.-]|$)/.test(model)) {
        return reasoning
          ? policy(providerType, 'explicit-on', '已开启千问条件思考', { enable_thinking: true })
          : policy(providerType, 'explicit-off', '已强制关闭千问思考模式', {
            enable_thinking: false,
          })
      }
      return policy(providerType, 'unknown', '无法确认该千问型号是否支持非思考模式')
    case 'kimi':
      if (/^kimi-k3(?:[.-]|$)/.test(model)) {
        return policy(providerType, 'always-on', 'Kimi K3 自动思考，已使用模型固定采样参数', {
          temperature: 1, top_p: 0.95,
        })
      }
      if (model.includes('thinking')) {
        return policy(providerType, 'reasoning-only', 'Kimi Thinking 型号属于推理专用模型，请改用 K2.5/K2.6')
      }
      if (/^kimi-k2[.-](?:5|6)(?:[.-]|$)/.test(model)) {
        return policy(providerType, 'explicit-off', '已强制关闭 Kimi 思考模式', {
          thinking: { type: 'disabled' }, temperature: 0.6, top_p: 0.95,
        }, true)
      }
      if (/^(?:kimi-k2|moonshot-v1)/.test(model)) {
        return policy(providerType, 'naturally-off', '该 Kimi 型号本身不输出思考链')
      }
      return policy(providerType, 'unknown', '无法确认该 Kimi 型号是否支持非思考模式')
    case 'doubao':
      if (model.includes('thinking')) {
        return policy(providerType, 'explicit-off', '已强制关闭豆包思考模式', {
          thinking: { type: 'disabled' },
        })
      }
      if (/^doubao/.test(model)) {
        return policy(providerType, 'naturally-off', '该豆包型号按非思考模型调用')
      }
      return policy(providerType, 'unknown', '无法确认该豆包接入点是否支持非思考模式')
    case 'minimax':
      if (/^minimax-m(?:1|2)(?:[.-]|$)/.test(model)) {
        return policy(providerType, 'reasoning-only', 'MiniMax M1/M2 系列为推理模型，当前没有可靠关闭开关')
      }
      if (/^minimax-(?:text|01)/.test(model)) {
        return policy(providerType, 'naturally-off', '该 MiniMax 型号本身不输出思考链')
      }
      return policy(providerType, 'unknown', '无法确认该 MiniMax 型号是否支持非思考模式')
    case 'openai':
      if (/^o(?:1|3|4)(?:[.-]|$)/.test(model)) {
        return policy(providerType, 'reasoning-only', 'OpenAI o 系列属于推理模型，不适合实时麻将决策')
      }
      if (/^gpt-5(?:[.-]|$)/.test(model)) {
        return reasoning
          ? policy(providerType, 'explicit-on', '已开启 GPT 条件思考', { reasoning_effort: 'medium' })
          : policy(providerType, 'explicit-off', '已将 GPT 推理强度设为 none', {
            reasoning_effort: 'none',
          })
      }
      if (/^(?:gpt-4|gpt-3\.5)/.test(model)) {
        return policy(providerType, 'naturally-off', '该 GPT 型号本身不是推理模型')
      }
      return policy(providerType, 'unknown', '无法确认该 OpenAI 型号是否能关闭推理')
    case 'glm':
      if (model.includes('thinking')) {
        return policy(providerType, 'reasoning-only', '显式 Thinking 型号不用于实时麻将决策')
      }
      if (/^glm-5\.3(?:[.-]|$)/.test(model)) {
        return policy(providerType, 'always-on', 'GLM-5.3 始终思考，已使用最低推理强度', {
          thinking: { type: 'enabled' }, reasoning_effort: 'low',
        })
      }
      if (/^glm-(?:4\.(?:5|6|7)|5)(?:[.-]|$)/.test(model)) {
        return policy(providerType, 'explicit-off', '已强制关闭 GLM 思考模式', {
          thinking: { type: 'disabled' },
        })
      }
      if (/^glm-4(?:[.-]|$)/.test(model)) {
        return policy(providerType, 'naturally-off', '该 GLM 型号本身不是思考模型')
      }
      return policy(providerType, 'unknown', '无法确认该 GLM 型号是否支持非思考模式')
    case 'claude':
      if (/^claude-sonnet-5(?:[.-]|$)/.test(model)) {
        return reasoning
          ? policy(providerType, 'explicit-on', '已开启 Claude Sonnet 5 自适应思考', {
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: 'medium' },
          })
          : policy(providerType, 'explicit-off', '已关闭 Claude Sonnet 5 自适应思考', {
            thinking: { type: 'disabled' },
          })
      }
      return policy(providerType, 'naturally-off', 'Claude 扩展思考为显式开启；当前请求不会开启')
    default:
      return policy(providerType, 'unknown', '自定义 OpenAI 兼容协议按用户配置直接请求')
  }
}
