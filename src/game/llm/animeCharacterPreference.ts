import {
  DEFAULT_ANIME_CHARACTER_ID,
  resolveAnimeCharacterId,
  type CharacterId,
} from './animeCharacters'

export const ANIME_CHARACTER_STORAGE_KEY = 'llm-anime.character.v1'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readAnimeCharacterPreference(
  storage: StorageLike | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): CharacterId {
  if (!storage) return DEFAULT_ANIME_CHARACTER_ID
  try { return resolveAnimeCharacterId(storage.getItem(ANIME_CHARACTER_STORAGE_KEY)) } catch { return DEFAULT_ANIME_CHARACTER_ID }
}

export function saveAnimeCharacterPreference(
  characterId: unknown,
  storage: StorageLike | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): CharacterId {
  const resolved = resolveAnimeCharacterId(characterId)
  try { storage?.setItem(ANIME_CHARACTER_STORAGE_KEY, resolved) } catch { /* 存储不可用不影响开局 */ }
  return resolved
}

const CHARACTER_WITH_LOCAL_AVATAR = new Set([
  'claude', 'deepseek', 'doubao', 'gemini', 'glm', 'gpt',
  'grok', 'kimi', 'minimax', 'muse', 'qwen',
])

/** 首版选择器沿用现有稳健头像；尚无头像的 Mistral 回退 DeepSeek。 */
export function animeCharacterAvatarUrl(characterId: unknown): string {
  const resolved = resolveAnimeCharacterId(characterId)
  const folder = CHARACTER_WITH_LOCAL_AVATAR.has(resolved) ? resolved : DEFAULT_ANIME_CHARACTER_ID
  return `${import.meta.env.BASE_URL}img/llm/${folder}/llm-avatar-wenjian.png`
}
