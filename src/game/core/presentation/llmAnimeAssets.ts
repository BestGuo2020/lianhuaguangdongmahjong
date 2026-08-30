import {
  ANIME_CHARACTER_IDS,
  resolveAnimeCharacterId,
  type CharacterId,
} from '../../llm/animeCharacters'
import type { AnimeActionKey } from './animeActionPresentation'

export const LLM_ANIME_ASSET_VERSION = 'v1'

export type AnimeActionCardKind = 'call' | 'win'

export function animeActionCardKind(action: AnimeActionKey): AnimeActionCardKind {
  return action === 'hu' || action === 'zimo' || action === 'qiangganghu' ? 'win' : 'call'
}

/** 每个角色只发布通用鸣牌卡与通用胡牌卡两张。 */
export const SHIPPED_ANIME_ACTION_CARD_CHARACTERS = ANIME_CHARACTER_IDS satisfies readonly CharacterId[]
const SHIPPED_ACTION_CARD_SET: ReadonlySet<string> = new Set(SHIPPED_ANIME_ACTION_CARD_CHARACTERS)

export function animeActionArtUrl(characterId: unknown, action: AnimeActionKey): string | null {
  const resolved = resolveAnimeCharacterId(characterId)
  if (!SHIPPED_ACTION_CARD_SET.has(resolved)) return null
  const kind = animeActionCardKind(action)
  return `${import.meta.env.BASE_URL}themes/llm-anime/${LLM_ANIME_ASSET_VERSION}/characters/${resolved}/actions/${kind}.jpg`
}
