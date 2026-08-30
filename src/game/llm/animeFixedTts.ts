import {
  ANIME_ACTION_VOICE_KEYS,
  ANIME_RESULT_VOICE_KEYS,
  ANIME_TTS_SPEAKERS,
  type AnimeTtsVoiceKey,
  type AnimeVoiceKey,
  type CharacterId,
  resolveAnimeCharacter,
} from './animeCharacters'

/** 请求结构变化时递增；用于识别调用方理解的合同版本。 */
export const ANIME_FIXED_TTS_SCHEMA_VERSION = 1 as const
/** 文案、音色或 cache identity 规则变化时递增，主动失效旧缓存。 */
export const ANIME_FIXED_TTS_CACHE_VERSION = 1 as const

export type AnimeFixedTtsKind = 'action' | 'result'
export type AnimeActionVoiceKey = typeof ANIME_ACTION_VOICE_KEYS[number]
export type AnimeResultVoiceKey = typeof ANIME_RESULT_VOICE_KEYS[number]

export interface AnimeFixedTtsRequest {
  readonly schemaVersion: typeof ANIME_FIXED_TTS_SCHEMA_VERSION
  readonly cacheVersion: typeof ANIME_FIXED_TTS_CACHE_VERSION
  readonly characterId: CharacterId
  readonly animeVoiceKey: AnimeVoiceKey
  readonly kind: AnimeFixedTtsKind
  readonly normalizedText: string
  readonly voiceKey: AnimeTtsVoiceKey
  readonly fallbackVoiceKey: AnimeTtsVoiceKey
  readonly style: '稳健'
  /** 稳定、可序列化的业务缓存身份；不等同于服务端最终音频 SHA256。 */
  readonly cacheIdentity: string
  /** 相同请求在客户端 single-flight Map 中使用的 key。 */
  readonly singleFlightKey: string
}

export interface AnimeFixedTtsCacheIdentityParts {
  readonly schemaVersion: number
  readonly cacheVersion: number
  readonly characterId: CharacterId
  readonly animeVoiceKey: AnimeVoiceKey
  readonly kind: AnimeFixedTtsKind
  readonly normalizedText: string
  readonly voiceKey: AnimeTtsVoiceKey
  readonly speaker: string
  readonly fallbackVoiceKey: AnimeTtsVoiceKey
  readonly fallbackSpeaker: string
  readonly style: '稳健'
}

const ACTION_VOICE_KEY_SET: ReadonlySet<AnimeVoiceKey> = new Set(ANIME_ACTION_VOICE_KEYS)
const RESULT_VOICE_KEY_SET: ReadonlySet<AnimeVoiceKey> = new Set(ANIME_RESULT_VOICE_KEYS)

export function isAnimeActionVoiceKey(key: AnimeVoiceKey): key is AnimeActionVoiceKey {
  return ACTION_VOICE_KEY_SET.has(key)
}

export function isAnimeResultVoiceKey(key: AnimeVoiceKey): key is AnimeResultVoiceKey {
  return RESULT_VOICE_KEY_SET.has(key)
}

export function classifyAnimeVoiceKey(key: AnimeVoiceKey): AnimeFixedTtsKind {
  return isAnimeActionVoiceKey(key) ? 'action' : 'result'
}

/** 与现有 LocalTtsClient 请求前规范化规则保持一致。 */
export function normalizeAnimeFixedTtsText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 30)
}

/**
 * 用固定字段顺序生成跨运行稳定的 identity。采用 JSON 数组避免分隔符碰撞，
 * 同时让 schema/cache version、speaker 和 fallback 变更都能失效旧身份。
 */
export function buildAnimeFixedTtsCacheIdentity(
  parts: AnimeFixedTtsCacheIdentityParts,
): string {
  return JSON.stringify([
    'llm-anime-fixed-tts',
    parts.schemaVersion,
    parts.cacheVersion,
    parts.characterId,
    parts.animeVoiceKey,
    parts.kind,
    parts.normalizedText,
    parts.voiceKey,
    parts.speaker,
    parts.fallbackVoiceKey,
    parts.fallbackSpeaker,
    parts.style,
  ])
}

/**
 * 把角色和固定文案槽位解析为无副作用的合成请求描述。未知角色由角色合同
 * 统一回退 DeepSeek；该函数不读主题、不访问缓存，也不发起网络请求。
 */
export function createAnimeFixedTtsRequest(
  characterId: unknown,
  animeVoiceKey: AnimeVoiceKey,
): AnimeFixedTtsRequest {
  const character = resolveAnimeCharacter(characterId)
  const kind = classifyAnimeVoiceKey(animeVoiceKey)
  const normalizedText = normalizeAnimeFixedTtsText(character.lines[animeVoiceKey])
  const identityParts: AnimeFixedTtsCacheIdentityParts = {
    schemaVersion: ANIME_FIXED_TTS_SCHEMA_VERSION,
    cacheVersion: ANIME_FIXED_TTS_CACHE_VERSION,
    characterId: character.id,
    animeVoiceKey,
    kind,
    normalizedText,
    voiceKey: character.voiceKey,
    speaker: character.speaker,
    fallbackVoiceKey: character.fallbackVoiceKey,
    fallbackSpeaker: ANIME_TTS_SPEAKERS[character.fallbackVoiceKey],
    style: '稳健',
  }
  const cacheIdentity = buildAnimeFixedTtsCacheIdentity(identityParts)
  return {
    schemaVersion: ANIME_FIXED_TTS_SCHEMA_VERSION,
    cacheVersion: ANIME_FIXED_TTS_CACHE_VERSION,
    characterId: character.id,
    animeVoiceKey,
    kind,
    normalizedText,
    voiceKey: character.voiceKey,
    fallbackVoiceKey: character.fallbackVoiceKey,
    style: '稳健',
    cacheIdentity,
    singleFlightKey: `singleflight:${cacheIdentity}`,
  }
}
