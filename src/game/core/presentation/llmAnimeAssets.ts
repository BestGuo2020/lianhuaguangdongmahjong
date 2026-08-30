import {
  DEFAULT_ANIME_CHARACTER_ID,
  resolveAnimeCharacterId,
  type CharacterId,
} from '../../llm/animeCharacters'

export const LLM_ANIME_ASSET_VERSION = 'v1'

/** 只有通过真 alpha 与人工 QA 的立绘才能加入。 */
export const SHIPPED_ANIME_PORTRAITS = ['deepseek'] as const satisfies readonly CharacterId[]
const SHIPPED_PORTRAIT_SET: ReadonlySet<string> = new Set(SHIPPED_ANIME_PORTRAITS)

export function resolveShippedAnimePortraitId(characterId: unknown): CharacterId {
  const resolved = resolveAnimeCharacterId(characterId)
  return SHIPPED_PORTRAIT_SET.has(resolved) ? resolved : DEFAULT_ANIME_CHARACTER_ID
}

export function animePortraitUrl(characterId: unknown): string {
  const resolved = resolveShippedAnimePortraitId(characterId)
  return `${import.meta.env.BASE_URL}themes/llm-anime/${LLM_ANIME_ASSET_VERSION}/characters/${resolved}/portrait.png`
}
