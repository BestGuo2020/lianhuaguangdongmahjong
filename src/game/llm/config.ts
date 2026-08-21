// LLM 提供商配置：类型 + localStorage 持久化（带 configVersion 的版本化存储）。
// docs/llm-ai-design.md §9.1：Key 只存本地浏览器，只发送用户选择的供应商，不落日志。
import type { Band } from './schema'

export interface LlmProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 激进 / 稳健 / 话痨 / 高冷 */
  style: '激进' | '稳健' | '话痨' | '高冷'
  /** 一次决策的总预算（连接+解析+最多一次语义重试），默认 8000ms */
  timeoutMs: number
}

export const DEFAULT_PROVIDER: Omit<LlmProviderConfig, 'apiKey'> = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  style: '稳健',
  timeoutMs: 8000,
}

export const CONFIG_VERSION = 1

const STORAGE_KEY = 'llm.provider'
const ENABLED_KEY = 'llm.enabled'

export function readLlmConfig(storage: Pick<Storage, 'getItem'> = localStorage): {
  config: LlmProviderConfig
  enabled: boolean
} {
  let enabled = false
  let config: LlmProviderConfig = { ...DEFAULT_PROVIDER, apiKey: '' }
  try {
    const rawEnabled = storage.getItem(ENABLED_KEY)
    if (rawEnabled != null) enabled = rawEnabled === '1'
    const raw = storage.getItem(STORAGE_KEY)
    if (raw != null) {
      const parsed = JSON.parse(raw) as { configVersion?: number } & Partial<LlmProviderConfig>
      // 版本迁移：configVersion 不匹配时丢弃旧配置（保留用户 key 的迁移由设置页处理）
      if (parsed.configVersion === CONFIG_VERSION) {
        config = {
          baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : DEFAULT_PROVIDER.baseUrl,
          apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
          model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_PROVIDER.model,
          style: (['激进', '稳健', '话痨', '高冷'] as const).includes(parsed.style as never)
            ? parsed.style
            : DEFAULT_PROVIDER.style,
          timeoutMs: typeof parsed.timeoutMs === 'number' && parsed.timeoutMs > 0
            ? parsed.timeoutMs
            : DEFAULT_PROVIDER.timeoutMs,
        }
      }
    }
  } catch {
    // 配置损坏时回退默认（key 为空 → 人机禁用 LLM）
  }
  return { config, enabled }
}

export function writeLlmConfig(
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage,
  patch: Partial<Omit<LlmProviderConfig, never>> & { enabled?: boolean } = {},
): LlmProviderConfig {
  const current = readLlmConfig(storage as Storage)
  const next: LlmProviderConfig = {
    ...current.config,
    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
    ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.style !== undefined ? { style: patch.style } : {}),
    ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
  }
  storage.setItem(STORAGE_KEY, JSON.stringify({
    configVersion: CONFIG_VERSION,
    baseUrl: next.baseUrl,
    apiKey: next.apiKey,
    model: next.model,
    style: next.style,
    timeoutMs: next.timeoutMs,
  }))
  if (patch.enabled !== undefined) {
    storage.setItem(ENABLED_KEY, patch.enabled ? '1' : '0')
  }
  return next
}

/** 设置页「测试连接」用：探测供应商可用性（不落日志，不回显 key）。 */
export function normalizeBaseUrl(baseUrl: string): string | null {
  let value = baseUrl.trim()
  if (!value) return null
  // 拒绝带 userinfo 的 URL（避免 key 拼入 URL 的坏习惯/注入）
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null
  } catch {
    return null
  }
  // 规范化：去掉末尾斜杠；只能追加一次 /chat/completions
  const trimmed = value.replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  return `${trimmed}/chat/completions`
}

export type { Band }
