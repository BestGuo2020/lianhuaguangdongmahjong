// 千问 Token Plan「经网关」预置的回归测试。
//
// 事实（2026-09-18 实测，见 config.ts 的注释）：token-plan / coding plan 端点对
// 浏览器预检直接 401 且不带任何 CORS 头，网页不能直连；官方也明确 Token Plan /
// Coding Plan / 按量付费三套 Base URL 与凭证不可混用。所以预置必须给自家透传地址，
// 且不能让用户在原地址上踩坑。本文件同时锁住「网关地址能通过客户端校验」这条契约。
import { describe, expect, it } from 'vitest'
import {
  LLM_RELAY_GATEWAY,
  LLM_RELAY_UPSTREAM_TOKEN_PLAN,
  LLM_DECISION_TIMEOUT_MS,
  PROVIDER_TEMPLATES,
  llmRelayBaseUrl,
  normalizeBaseUrl,
  type LlmProviderPreset,
} from './config'
import { avatarFolderFor, avatarFolderOf, avatarFor, defaultNicknameFor } from './persona'
import { inferProviderDialect, resolveReasoningPolicy } from './reasoningPolicy'
import { resolveLocalTtsVoiceKey } from './localTtsClient'

const TOKEN_PLAN_VENDOR_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'

function tokenPlanTemplate() {
  const found = PROVIDER_TEMPLATES.find((item) => item.baseUrl.includes('/api/llm/relay/'))
  if (!found) throw new Error('缺少「经网关」的千问 Token Plan 预置')
  return found
}

function tokenPlanPreset(): LlmProviderPreset {
  const template = tokenPlanTemplate()
  return {
    id: 'p-token-plan',
    name: template.name,
    providerType: template.providerType,
    baseUrl: template.baseUrl,
    apiKey: 'sk-sp-test',
    model: template.model,
    style: '稳健',
    timeoutMs: LLM_DECISION_TIMEOUT_MS,
    timeoutEnabled: true,
  }
}

describe('千问 Token Plan 预置走自家透传网关', () => {
  it('预置给的是网关地址，不再提供浏览器直连会被拦的原地址', () => {
    const template = tokenPlanTemplate()
    expect(template.baseUrl).toBe(`${LLM_RELAY_GATEWAY}/api/llm/relay/${LLM_RELAY_UPSTREAM_TOKEN_PLAN}`)
    expect(template.providerType).toBe('qwen')
    expect(PROVIDER_TEMPLATES.some((item) => item.baseUrl.includes('token-plan.cn-beijing.maas.aliyuncs.com')))
      .toBe(false)
  })

  it('自定义模板仍是最后一项（设置页按「最后一项 = 自定义」判定）', () => {
    expect(PROVIDER_TEMPLATES[PROVIDER_TEMPLATES.length - 1].providerType).toBe('custom')
    expect(PROVIDER_TEMPLATES.indexOf(tokenPlanTemplate()))
      .toBeLessThan(PROVIDER_TEMPLATES.length - 1)
  })

  it('网关地址能通过客户端校验，并拼出后端路由的 /chat/completions', () => {
    // 客户端拒绝相对地址与非 https；这里的地址必须两端都成立。
    expect(normalizeBaseUrl(llmRelayBaseUrl(LLM_RELAY_UPSTREAM_TOKEN_PLAN)))
      .toBe('https://www.bestguo.top:58000/api/llm/relay/token-plan/chat/completions')
  })

  it('供应商类型、头像、昵称、TTS 音色都识别为千问', () => {
    const template = tokenPlanTemplate()
    const preset = tokenPlanPreset()
    expect(avatarFolderOf({ baseUrl: template.baseUrl, providerType: template.providerType, model: template.model }))
      .toBe('qwen')
    expect(avatarFor(preset, '高冷')).toContain('img/llm/qwen/llm-avatar-gaoleng.png')
    expect(defaultNicknameFor(template.baseUrl, template.name)).toBe('千问大小姐')
    expect(resolveLocalTtsVoiceKey(preset)).toBe('qwen')
    // 直接填供应商原地址（旧配置）也应识别为千问，避免迁移后变成「自定义」。
    expect(defaultNicknameFor(TOKEN_PLAN_VENDOR_URL, '通义千问')).toBe('千问大小姐')
    expect(avatarFolderFor(TOKEN_PLAN_VENDOR_URL)).toBe('qwen')
  })

  it('网关地址不是厂商官方域名（方言退化为 compatible），但仍强制关闭千问思考', () => {
    const template = tokenPlanTemplate()
    // 走网关后 hostname 是自家网关，官方端点表当然匹配不上——这是预期的，
    // 关键是决策参数不能因此变化（qwen 分支不依赖方言）。
    expect(inferProviderDialect(template.baseUrl)).toBe('compatible')
    expect(resolveReasoningPolicy({
      baseUrl: template.baseUrl, model: template.model, providerType: 'qwen',
    })).toMatchObject({
      providerType: 'qwen', mode: 'explicit-off', requestBody: { enable_thinking: false },
    })
  })

  it('预置模型在 Token Plan 的能力矩阵内（未知型号会让思考开关失效）', () => {
    const policy = resolveReasoningPolicy({
      baseUrl: tokenPlanTemplate().baseUrl,
      model: tokenPlanTemplate().model,
      providerType: 'qwen',
    })
    expect(policy.mode).not.toBe('unknown')
    expect(tokenPlanTemplate().model.startsWith('qwen3.')).toBe(true)
  })
})
