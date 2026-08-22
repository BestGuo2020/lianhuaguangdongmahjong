// LLM 供应商配置 v2 —— 多预置 + 按座位分配。
// 存储（带 configVersion 的版本化迁移）：
//   llm.providers : { configVersion: 2, enabled, presets: LlmProviderPreset[], activeId, seatIds }
//   （旧 v1 的 llm.provider 在迁移时并入）
// 安全约定（§9.1/§9.5）：Key 只存本地浏览器、只发送给用户选择的供应商、不落日志。
import type { RuleCode } from './schema'

export type LlmStyle = '激进' | '稳健' | '话痨' | '高冷'

/** 单次调用配置（运行时/客户端使用） */
export interface LlmProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  style: LlmStyle
  /** 一次决策的总预算（含连接/解析/一次语义重试） */
  timeoutMs: number
}

export interface LlmProviderPreset extends LlmProviderConfig {
  id: string
  /** 展示名（如 "DeepSeek"、"我家Kimi"） */
  name: string
  /** 自定义昵称（可选；缺省按供应商推导，如 DeepSeek=大肥鱼） */
  nickname?: string
}

export interface LlmSettings {
  enabled: boolean
  presets: LlmProviderPreset[]
  /** 默认预置 id（未单独指定座位的 AI 使用） */
  activeId: string | null
  /** 座位 → 预置 id（下标 1..3；null=跟随默认） */
  seatIds: Array<string | null>
  /** 座位 → 风格覆盖（下标 1..3；null=跟随预置风格）——不同座位可用不同风格 */
  seatStyles: Array<LlmStyle | null>
}

export const CONFIG_VERSION = 2
const STORAGE_KEY = 'llm.providers'
const LEGACY_KEY = 'llm.provider'
const LEGACY_ENABLED_KEY = 'llm.enabled'

export const DEFAULT_PRESET: Omit<LlmProviderPreset, 'id' | 'name' | 'apiKey'> = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  style: '稳健',
  timeoutMs: 8000,
}

/** 常用供应商模板（Base URL + 示例模型，模型名需按官方文档核对） */
export const PROVIDER_TEMPLATES: Array<{ name: string; baseUrl: string; model: string }> = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  { name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
  { name: '通义千问 (DashScope)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '豆包 (Volcano Ark)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k-250115' },
  { name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-Text-01' },
  { name: 'OpenAI (GPT)', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: '智谱 (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { name: '自定义', baseUrl: '', model: '' },
]

export function emptyLlmSettings(): LlmSettings {
  return {
    enabled: false, presets: [], activeId: null,
    seatIds: [null, null, null, null],
    seatStyles: [null, null, null, null],
  }
}

function validateStyle(value: unknown): LlmStyle {
  return (['激进', '稳健', '话痨', '高冷'] as const).includes(value as LlmStyle) ? value as LlmStyle : DEFAULT_PRESET.style
}

function validateStyleOrNull(value: unknown): LlmStyle | null {
  return value === null || value === undefined ? null : validateStyle(value)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function normalizePreset(raw: Record<string, unknown>): LlmProviderPreset | null {
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : ''
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : ''
  const model = typeof raw.model === 'string' && raw.model ? raw.model : ''
  const name = typeof raw.name === 'string' && raw.name ? raw.name : '未命名'
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `p${Math.random().toString(36).slice(2, 8)}`
  const nickname = typeof raw.nickname === 'string' ? raw.nickname : undefined
  if (!baseUrl && !apiKey && !model) return null
  return {
    id, name, baseUrl, apiKey, model,
    ...(nickname ? { nickname } : {}),
    style: validateStyle(raw.style),
    timeoutMs: typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_PRESET.timeoutMs,
  }
}

/** 读取 v2 配置；无 v2 时从 v1（单预置）迁移。 */
export function readLlmSettings(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage): LlmSettings {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw != null) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.configVersion === CONFIG_VERSION) {
        const presets = (Array.isArray(parsed.presets) ? parsed.presets : [])
          .map((item) => normalizePreset(isRecord(item) ? item : {}))
          .filter((preset): preset is LlmProviderPreset => preset !== null)
        const rawSeats = Array.isArray(parsed.seatIds) ? parsed.seatIds : []
        const seatIds: Array<string | null> = [null, rawSeats[1] ?? null, rawSeats[2] ?? null, rawSeats[3] ?? null]
        const rawStyles = Array.isArray(parsed.seatStyles) ? parsed.seatStyles : []
        const seatStyles: Array<LlmStyle | null> = [
          null, validateStyleOrNull(rawStyles[1]), validateStyleOrNull(rawStyles[2]), validateStyleOrNull(rawStyles[3]),
        ]
        const activeId = typeof parsed.activeId === 'string' && presets.some((preset) => preset.id === parsed.activeId)
          ? parsed.activeId
          : presets[0]?.id ?? null
        return {
          enabled: parsed.enabled === true,
          presets,
          activeId,
          seatIds,
          seatStyles,
        }
      }
    }
    // ── v1 迁移：单预置 → v2 默认预置 ──
    const legacy = storage.getItem(LEGACY_KEY)
    if (legacy != null) {
      const parsed = JSON.parse(legacy) as Record<string, unknown>
      if (parsed.configVersion === 1) {
        const preset = normalizePreset(parsed)
        if (preset) {
          preset.name = '默认'
          const migrated: LlmSettings = {
            enabled: storage.getItem(LEGACY_ENABLED_KEY) === '1',
            presets: [preset],
            activeId: preset.id,
            seatIds: [null, null, null, null],
            seatStyles: [null, null, null, null],
          }
          try {
            storage.setItem(STORAGE_KEY, JSON.stringify({ configVersion: CONFIG_VERSION, ...migrated }))
            storage.removeItem(LEGACY_KEY)
            storage.removeItem(LEGACY_ENABLED_KEY)
          } catch { /* 读也不受影响 */ }
          return migrated
        }
      }
    }
  } catch {
    // 损坏配置回退空集（Key 为空 → 人机禁用 LLM）
  }
  return emptyLlmSettings()
}

export function saveLlmSettings(
  settings: LlmSettings,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ configVersion: CONFIG_VERSION, ...settings }))
}

/** 按座位取实际使用的预置（座位未指定 → 默认预置）；返回 null 表示该座位不可用 LLM。 */
export function presetForSeat(settings: LlmSettings, seat: 1 | 2 | 3): LlmProviderPreset | null {
  const seatId = settings.seatIds[seat]
  const preset = settings.presets.find((item) => item.id === (seatId || settings.activeId))
  return preset ?? null
}

/** 该座位的实际风格：座位覆盖优先，否则预置风格。 */
export function styleForSeat(settings: LlmSettings, seat: 1 | 2 | 3): LlmStyle | null {
  const preset = presetForSeat(settings, seat)
  if (!preset) return null
  return settings.seatStyles[seat] ?? preset.style
}

/** 唯一 id（不含用户可读信息） */
export function newPresetId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
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

export type { RuleCode }
