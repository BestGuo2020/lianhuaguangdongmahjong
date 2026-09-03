import {
  ANIME_CHARACTER_IDS,
  resolveAnimeCharacterId,
  type CharacterId,
} from '../../llm/animeCharacters'
import { animeCharacterAvatarUrl } from '../../llm/animeCharacterPreference'
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

// 二次元主题的角色头像与鸣牌/胡牌立绘预热：选择主题或开局前拉进浏览器缓存，
// 避免立绘/头像首次出现时闪烁或延迟。失败静默（首次使用时仍按需加载）。
let assetPreloadReady: Promise<void> | null = null

function preloadImage(src: string): Promise<void> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve()
    image.onerror = () => resolve()
    image.src = src
  })
}

/** 预取全部角色头像 + 每角色两张立绘（鸣牌卡/胡牌卡）。并发调用复用同一 Promise。 */
export function preloadAnimeCharacterAssets(): Promise<void> {
  if (assetPreloadReady) return assetPreloadReady
  const urls = ANIME_CHARACTER_IDS.flatMap((id) => [
    animeCharacterAvatarUrl(id),
    animeActionArtUrl(id, 'peng'),
    animeActionArtUrl(id, 'hu'),
  ]).filter((url): url is string => Boolean(url))
  assetPreloadReady = Promise.all(urls.map(preloadImage)).then(() => {})
  return assetPreloadReady
}
