import {
  ANIME_CHARACTER_IDS,
  resolveAnimeCharacterId,
  type CharacterId,
} from '../../llm/animeCharacters'
import { animeCharacterAvatarUrl } from '../../llm/animeCharacterPreference'
import { preloadImages, materializeImages, materializedImageSrc } from './imagePreload'
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
 * 头像与立绘都走「物化」：抓成 blob URL 并预热解码。它们出现的窗口很短或会被反复重建
 * （吃碰杠 cue 1s 级、血流胡牌立绘满不透明度约 370ms、座位与结算名单每局重建），
 * 只把字节放进 HTTP 缓存不够——线上静态资源 `cache-control: public, max-age=60`，
 * 过了新鲜期每次渲染都要先发一次协商校验、再叠现场解码（实测单张 249KB 在真实网络下
 * 要 0.7~1.7 秒），头像/立绘就会迟到或时有时无。blob 是同源本地字节、不会再校验。
 *
 * 物化失败的 URL（无 blob 支持 / 抓取失败）再退回普通预取兜底；都失败时按需加载，行为不会更差。
 */
export function preloadAnimeCharacterAssets(): Promise<void> {
  if (assetPreloadReady) return assetPreloadReady
  const avatars = ANIME_CHARACTER_IDS.map((id) => animeCharacterAvatarUrl(id))
  const actionCards = ANIME_CHARACTER_IDS.flatMap((id) => [
    animeActionArtUrl(id, 'peng'),
    animeActionArtUrl(id, 'hu'),
  ]).filter((url): url is string => Boolean(url))
  const all = [...avatars, ...actionCards]
  assetPreloadReady = materializeImages(all)
    .then(() => preloadImages(all.filter((url) => !materializedImageSrc(url))))
  return assetPreloadReady
}
