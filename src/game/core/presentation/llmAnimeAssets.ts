import {
  ANIME_CHARACTER_IDS,
  resolveAnimeCharacterId,
  type CharacterId,
} from '../../llm/animeCharacters'
import { animeCharacterAvatarUrl } from '../../llm/animeCharacterPreference'
import { preloadImages, materializeImages } from './imagePreload'
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

/**
 * 预取全部角色头像 + 每角色两张立绘（鸣牌卡/胡牌卡）。并发调用复用同一 Promise。
 *
 * 立绘额外做一次「物化」：抓成 blob URL 并预热解码。动作 cue 的出现窗口很短（吃碰杠约 1s 级），
 * 只把字节放进 HTTP 缓存仍然不够——线上静态资源 `max-age=60`，过了新鲜期每次渲染都要先发一次
 * 304 校验，再加上现场解码，立绘就会时有时无。blob URL 是同源本地字节、不会再校验，
 * `AnimeActionCue` 直接引用它即可稳定上屏（拿不到就回退原始 URL，行为不变差）。
 */
export function preloadAnimeCharacterAssets(): Promise<void> {
  if (assetPreloadReady) return assetPreloadReady
  const avatars = ANIME_CHARACTER_IDS.map((id) => animeCharacterAvatarUrl(id))
  const actionCards = ANIME_CHARACTER_IDS.flatMap((id) => [
    animeActionArtUrl(id, 'peng'),
    animeActionArtUrl(id, 'hu'),
  ]).filter((url): url is string => Boolean(url))
  assetPreloadReady = Promise.all([
    preloadImages([...avatars, ...actionCards]),
    materializeImages(actionCards),
  ]).then(() => {})
  return assetPreloadReady
}
