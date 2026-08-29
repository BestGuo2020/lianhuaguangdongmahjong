// LLM 供应商配置 v2 —— 多预置 + 按座位分配。
// 存储（带 configVersion 的版本化迁移）：
//   llm.providers : { configVersion: 2, enabled, presets: LlmProviderPreset[], activeId, seatIds }
//   （旧 v1 的 llm.provider 在迁移时并入）
// 安全约定（§9.1/§9.5）：Key 只存本地浏览器、只发送给用户选择的供应商、不落日志。
import type { RuleCode } from './schema'

export type LlmStyle = '激进' | '稳健' | '话痨' | '高冷'
export const LLM_TTS_VOICE_OPTIONS = [
  { value: 'auto', label: '自动识别模型' },
  { value: 'default', label: '策略默认音色' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: '通义千问' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'doubao', label: '豆包' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'gpt', label: 'GPT' },
  { value: 'relay_gpt', label: '中转站 GPT' },
  { value: 'glm', label: '智谱 GLM' },
  { value: 'claude', label: 'Claude' },
] as const
export type LlmTtsVoiceKey = typeof LLM_TTS_VOICE_OPTIONS[number]['value']
export type LlmProviderType = 'deepseek' | 'qwen' | 'kimi' | 'doubao' | 'minimax' | 'openai' | 'glm' | 'claude' | 'custom'

export const LLM_PROVIDER_TYPES: Array<{ value: LlmProviderType; label: string }> = [
  { value: 'deepseek', label: 'DeepSeek' }, { value: 'qwen', label: '通义千问' },
  { value: 'kimi', label: 'Kimi' }, { value: 'doubao', label: '豆包' },
  { value: 'minimax', label: 'MiniMax' }, { value: 'openai', label: 'OpenAI / GPT' },
  { value: 'glm', label: '智谱 GLM（含兼容中转）' }, { value: 'claude', label: 'Claude' },
  { value: 'custom', label: '自定义 OpenAI 兼容协议' },
]

/** 单次调用配置（运行时/客户端使用） */
export interface LlmProviderConfig {
  providerType?: LlmProviderType
  baseUrl: string
  apiKey: string
  model: string
  style: LlmStyle
  /** 一次决策的总预算（含连接/解析/一次语义重试） */
  timeoutMs: number
  /** 牌桌请求是否启用超时；false 时仅由页面/对局重置等外部取消结束。 */
  timeoutEnabled?: boolean
}

export interface LlmProviderPreset extends LlmProviderConfig {
  id: string
  /** 展示名（如 "DeepSeek"、"我家Kimi"） */
  name: string
  /** 自定义昵称（可选；缺省按供应商推导，如 DeepSeek=大肥鱼） */
  nickname?: string
  /** 由「自定义」模板创建：可手动指定头像文件夹（如 gpt；留空=自动判定） */
  fromCustomTemplate?: boolean
  /** 头像文件夹覆盖（仅自定义模板预置显示/使用；通过 Base URL 自动识别的预置不需要） */
  avatarFolder?: string
  /** 单机 TTS 发音人映射；auto 按供应商头像档案推导。 */
  ttsVoiceKey?: LlmTtsVoiceKey
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
/** 所有供应商的游戏决策统一最长等待 40 秒。 */
export const LLM_DECISION_TIMEOUT_MS = 40_000
/** 仅设置页连接探测使用，不能截断真实游戏决策。 */
export const LLM_CONNECTION_TEST_TIMEOUT_MS = 8_000
export const LLM_SETTINGS_FILE_KIND = 'lianhua-guangma-llm-settings'
export const LLM_SETTINGS_FILE_VERSION = 1
const STORAGE_KEY = 'llm.providers'
const LEGACY_KEY = 'llm.provider'
const LEGACY_ENABLED_KEY = 'llm.enabled'

export const DEFAULT_PRESET: Omit<LlmProviderPreset, 'id' | 'name' | 'apiKey'> = {
  providerType: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  style: '稳健',
  timeoutMs: LLM_DECISION_TIMEOUT_MS,
  timeoutEnabled: true,
}

/** 常用供应商模板（Base URL + 示例模型，模型名需按官方文档核对） */
export const PROVIDER_TEMPLATES: Array<{ name: string; providerType: LlmProviderType; baseUrl: string; model: string }> = [
  { name: 'DeepSeek', providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  { name: 'Kimi (Moonshot)', providerType: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6' },
  { name: 'Kimi K2.6 (OrcaRouter)', providerType: 'kimi', baseUrl: 'https://api.orcarouter.ai/v1', model: 'kimi/kimi-k2.6' },
  { name: 'Kimi K3 (OrcaRouter)', providerType: 'kimi', baseUrl: 'https://api.orcarouter.ai/v1', model: 'kimi/kimi-k3' },
  { name: '通义千问 (DashScope)', providerType: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus' },
  { name: '豆包 (Volcano Ark)', providerType: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k-250115' },
  { name: 'MiniMax', providerType: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-Text-01' },
  { name: 'OpenAI (GPT)', providerType: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: '智谱 (GLM)', providerType: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash' },
  { name: 'GLM 5.3 Flash (OrcaRouter)', providerType: 'glm', baseUrl: 'https://api.orcarouter.ai/v1', model: 'z-ai/glm-5.3-flash' },
  { name: 'Claude (Anthropic)', providerType: 'claude', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514' },
  { name: '自定义', providerType: 'custom', baseUrl: '', model: '' },
]

export function inferLlmProviderType(baseUrl: string, model: string): LlmProviderType {
  const source = `${baseUrl} ${model}`.toLowerCase()
  if (/deepseek/.test(source)) return 'deepseek'
  if (/(?:dashscope|\.maas\.aliyuncs|qwen|qwq)/.test(source)) return 'qwen'
  if (/(?:moonshot|kimi)/.test(source)) return 'kimi'
  if (/(?:volces|volcengine|doubao)/.test(source)) return 'doubao'
  if (/minimax/.test(source)) return 'minimax'
  if (/(?:api\.openai\.com|\bgpt-|\bo[134](?:[.-]|\s|$))/.test(source)) return 'openai'
  if (/(?:bigmodel|\bglm-)/.test(source)) return 'glm'
  if (/(?:anthropic|\bclaude)/.test(source)) return 'claude'
  return 'custom'
}

function validateProviderType(value: unknown, baseUrl: string, model: string): LlmProviderType {
  return LLM_PROVIDER_TYPES.some((item) => item.value === value)
    ? value as LlmProviderType
    : inferLlmProviderType(baseUrl, model)
}

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

function validateTtsVoiceKey(value: unknown): LlmTtsVoiceKey {
  return LLM_TTS_VOICE_OPTIONS.some((item) => item.value === value)
    ? value as LlmTtsVoiceKey
    : 'auto'
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function normalizePreset(raw: Record<string, unknown>): LlmProviderPreset | null {
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : ''
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : ''
  const model = typeof raw.model === 'string' && raw.model ? raw.model : ''
  const name = typeof raw.name === 'string' && raw.name ? raw.name : '未命名'
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `p${Math.random().toString(36).slice(2, 8)}`
  const nickname = typeof raw.nickname === 'string' ? raw.nickname : undefined
  const avatarFolder = typeof raw.avatarFolder === 'string' ? raw.avatarFolder : undefined
  if (!baseUrl && !apiKey && !model) return null
  return {
    id, name, baseUrl, apiKey, model, providerType: validateProviderType(raw.providerType, baseUrl, model),
    ...(nickname ? { nickname } : {}),
    ...(raw.fromCustomTemplate === true ? { fromCustomTemplate: true } : {}),
    ...(avatarFolder ? { avatarFolder } : {}),
    ttsVoiceKey: validateTtsVoiceKey(raw.ttsVoiceKey),
    style: validateStyle(raw.style),
    // 决策预算为产品级统一参数；读取旧 localStorage 时统一升级为 40 秒。
    timeoutMs: LLM_DECISION_TIMEOUT_MS,
    timeoutEnabled: raw.timeoutEnabled !== false,
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

/**
 * 导出可迁移的模型配置。API Key 与运行时 timeout 不写入文件：前者避免泄漏，
 * 后者始终使用当前产品级预算，避免旧备份恢复过时值。
 */
export function serializeLlmSettings(settings: LlmSettings): string {
  const presets = settings.presets.map(({ apiKey: _apiKey, timeoutMs: _timeoutMs, ...preset }) => preset)
  return JSON.stringify({
    kind: LLM_SETTINGS_FILE_KIND,
    version: LLM_SETTINGS_FILE_VERSION,
    settings: {
      enabled: settings.enabled,
      presets,
      activeId: settings.activeId,
      seatIds: settings.seatIds,
      seatStyles: settings.seatStyles,
    },
  }, null, 2)
}

/**
 * 解析导入文件。文件中的 apiKey 永远忽略；同 id 的本机预置保留原 Key，
 * 新预置留空，用户检查并点击“保存”后才写入 localStorage。
 */
export function parseLlmSettingsJson(text: string, current: LlmSettings = emptyLlmSettings()): LlmSettings {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    throw new Error('JSON 格式无效')
  }
  if (!isRecord(root)
    || root.kind !== LLM_SETTINGS_FILE_KIND
    || root.version !== LLM_SETTINGS_FILE_VERSION
    || !isRecord(root.settings)) {
    throw new Error('不是受支持的莲花广麻大模型配置文件')
  }
  const rawSettings = root.settings
  if (!Array.isArray(rawSettings.presets)) throw new Error('presets 必须是数组')
  const currentKeys = new Map(current.presets.map((preset) => [preset.id, preset.apiKey]))
  const presets = rawSettings.presets.map((item, index) => {
    if (!isRecord(item)) throw new Error(`第 ${index + 1} 个预置格式无效`)
    const id = typeof item.id === 'string' ? item.id : ''
    const preset = normalizePreset({ ...item, apiKey: currentKeys.get(id) ?? '' })
    if (!preset) throw new Error(`第 ${index + 1} 个预置缺少 Base URL 或模型`)
    return preset
  })
  const ids = new Set<string>()
  for (const preset of presets) {
    if (ids.has(preset.id)) throw new Error(`预置 id 重复：${preset.id}`)
    ids.add(preset.id)
  }
  const activeId = typeof rawSettings.activeId === 'string' && ids.has(rawSettings.activeId)
    ? rawSettings.activeId
    : presets[0]?.id ?? null
  const rawSeats = Array.isArray(rawSettings.seatIds) ? rawSettings.seatIds : []
  const seatIds: Array<string | null> = [null, 1, 2, 3].map((_, index) => {
    if (index === 0) return null
    const id = rawSeats[index]
    return typeof id === 'string' && ids.has(id) ? id : null
  })
  const rawStyles = Array.isArray(rawSettings.seatStyles) ? rawSettings.seatStyles : []
  const seatStyles: Array<LlmStyle | null> = [
    null,
    validateStyleOrNull(rawStyles[1]),
    validateStyleOrNull(rawStyles[2]),
    validateStyleOrNull(rawStyles[3]),
  ]
  return {
    enabled: rawSettings.enabled === true,
    presets,
    activeId,
    seatIds,
    seatStyles,
  }
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
