// LLM 玩家形象：策略 → 头像（deepseek-strategy.png 四宫格裁切）、模型 → 默认昵称。
// 对局显示：`昵称（策略）`，如「大肥鱼（激进）」。
import type { LlmProviderPreset, LlmStyle } from './config'

/** 策略 → 头像文件（public/img/ 下四宫格裁切：左上激进、右上稳健、左下话痨、右下高冷） */
const STYLE_AVATARS: Record<LlmStyle, string> = {
  激进: 'llm-avatar-jijin.png',
  稳健: 'llm-avatar-wenjian.png',
  话痨: 'llm-avatar-huayao.png',
  高冷: 'llm-avatar-gaoleng.png',
}

export function avatarForStyle(style: LlmStyle): string {
  return `${import.meta.env.BASE_URL}img/${STYLE_AVATARS[style]}`
}

/** 模型供应商 → 默认昵称（DeepSeek 特殊为大肥鱼；其余用对应中文/通用名） */
const NICKNAME_HOSTS: Array<[RegExp, string]> = [
  [/api\.deepseek\.com/i, '大肥鱼'],
  [/api\.moonshot\.cn/i, 'Kimi'],
  [/dashscope\.aliyuncs\.com/i, '千问'],
  [/volces\.com|ark\.cn-beijing/i, '豆包'],
  [/api\.minimax\.chat/i, 'MiniMax'],
  [/api\.openai\.com/i, 'GPT'],
  [/open\.bigmodel\.cn/i, '智谱'],
]

/** 供应商默认昵称；未知供应商回退预置名。 */
export function defaultNicknameFor(baseUrl: string, presetName: string): string {
  const match = NICKNAME_HOSTS.find(([pattern]) => pattern.test(baseUrl))
  return match ? match[1] : (presetName.trim() || 'AI玩家')
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
