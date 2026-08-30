import {
  resolveAnimeCharacterId,
  type CharacterId,
} from '../../llm/animeCharacters'
import type { AnimeActionKey } from './animeActionPresentation'

export const LLM_ANIME_ASSET_VERSION = 'v1'

/** 专用 Q 版动作图按角色/动作逐张通过视觉 QA 后登记。 */
export const SHIPPED_ANIME_ACTIONS: Readonly<Partial<Record<CharacterId, readonly AnimeActionKey[]>>> = {
  deepseek: ['chi', 'peng', 'gang', 'hu', 'zimo', 'qiangganghu'],
}

export function animeActionArtUrl(characterId: unknown, action: AnimeActionKey): string | null {
  const resolved = resolveAnimeCharacterId(characterId)
  if (!SHIPPED_ANIME_ACTIONS[resolved]?.includes(action)) return null
  return `${import.meta.env.BASE_URL}themes/llm-anime/${LLM_ANIME_ASSET_VERSION}/characters/${resolved}/actions/${action}.jpg`
}
