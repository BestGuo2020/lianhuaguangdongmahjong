import {
  resolveAnimeCharacterId,
  type CharacterId,
} from '../../llm/animeCharacters'

/**
 * 角色强调色只用于头像描边、漫画气泡尾角和结算名次细线。
 * 大面积牌桌/UI 不使用角色色，避免重新形成持续高饱和霓虹环境。
 */
export const ANIME_CHARACTER_ACCENTS: Readonly<Record<CharacterId, string>> = {
  claude: '#c46f45',
  deepseek: '#527f89',
  doubao: '#4f8f8a',
  gemini: '#7d6a8d',
  glm: '#60666b',
  gpt: '#8d8493',
  grok: '#9e5148',
  kimi: '#6b7884',
  minimax: '#c76f55',
  mistral: '#b36a3f',
  muse: '#8a8176',
  qwen: '#6c7989',
}

export function animeCharacterAccent(characterId: unknown): string {
  return ANIME_CHARACTER_ACCENTS[resolveAnimeCharacterId(characterId)]
}
