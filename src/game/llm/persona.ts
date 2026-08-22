// LLM 玩家形象：供应商文件夹（img/llm/<provider>/）+ 策略头像 + 默认昵称。
// 对局显示：`昵称（策略）`，如「大肥鱼（激进）」。
// 素材结构：img/llm/<provider>/deepseek-strategy.png（四宫格：左上激进/右上稳健/左下话痨/右下高冷），
//           img/llm/<provider>/llm-avatar-<策略>.png（裁切产物）。
import type { LlmProviderPreset, LlmStyle } from './config'

/** 策略 → 裁切文件名 */
const STYLE_AVATARS: Record<LlmStyle, string> = {
  激进: 'llm-avatar-jijin.png',
  稳健: 'llm-avatar-wenjian.png',
  话痨: 'llm-avatar-huayao.png',
  高冷: 'llm-avatar-gaoleng.png',
}

/** 供应商档案：文件夹名（其英文名）+ 默认昵称（按 Base URL 识别；DeepSeek 特殊为大肥鱼） */
const PROVIDER_PROFILES: Array<{ pattern: RegExp; folder: string; nickname: string }> = [
  { pattern: /api\.deepseek\.com/i, folder: 'deepseek', nickname: '大肥鱼' },
  { pattern: /api\.moonshot\.cn/i, folder: 'kimi', nickname: 'Kimi' },
  { pattern: /dashscope\.aliyuncs\.com/i, folder: 'qwen', nickname: '千问' },
  { pattern: /volces\.com|ark\.cn-beijing/i, folder: 'doubao', nickname: '豆包' },
  { pattern: /api\.minimax\.chat/i, folder: 'minimax', nickname: 'MiniMax' },
  { pattern: /api\.openai\.com/i, folder: 'gpt', nickname: 'GPT' },
  { pattern: /open\.bigmodel\.cn/i, folder: 'zhipu', nickname: '智谱' },
]

function profileFor(baseUrl: string): { folder: string; nickname: string } {
  const match = PROVIDER_PROFILES.find((profile) => profile.pattern.test(baseUrl))
  return match ?? { folder: 'custom', nickname: '' }
}

/** 供应商头像文件夹名（英文名）；未知供应商为 custom。 */
export function avatarFolderFor(baseUrl: string): string {
  return profileFor(baseUrl).folder
}

/** 供应商默认昵称；未知供应商回退预置名。 */
export function defaultNicknameFor(baseUrl: string, presetName: string): string {
  const profile = profileFor(baseUrl)
  return profile.nickname || (presetName.trim() || 'AI玩家')
}

/** 头像 URL：按供应商文件夹 + 策略裁切文件。 */
export function avatarFor(baseUrl: string, style: LlmStyle): string {
  const folder = avatarFolderFor(baseUrl)
  return `${import.meta.env.BASE_URL}img/llm/${folder}/${STYLE_AVATARS[style]}`
}

/** 预置的生效昵称：自定义昵称优先，否则供应商默认。 */
export function effectiveNickname(preset: LlmProviderPreset): string {
  const custom = preset.nickname?.trim()
  return custom || defaultNicknameFor(preset.baseUrl, preset.name)
}

/** 对局显示名：昵称（策略）。 */
export function displayNameOf(nickname: string, style: LlmStyle): string {
  return `${nickname}（${style}）`
}
