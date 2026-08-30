import { describe, expect, it, vi } from 'vitest'
import {
  ANIME_CHARACTERS,
  ANIME_VOICE_KEYS,
} from './animeCharacters'
import {
  ANIME_FIXED_TTS_CACHE_VERSION,
  ANIME_FIXED_TTS_SCHEMA_VERSION,
  buildAnimeFixedTtsCacheIdentity,
  classifyAnimeVoiceKey,
  createAnimeFixedTtsRequest,
  isAnimeActionVoiceKey,
  isAnimeResultVoiceKey,
  normalizeAnimeFixedTtsText,
  type AnimeFixedTtsCacheIdentityParts,
} from './animeFixedTts'

describe('llmAnime fixed TTS contract', () => {
  it('把六个动作与五个结果 key 完整、互斥地分类', () => {
    expect(ANIME_VOICE_KEYS.filter(isAnimeActionVoiceKey)).toEqual([
      'chi', 'peng', 'gang', 'hu', 'zimo', 'qiangganghu',
    ])
    expect(ANIME_VOICE_KEYS.filter(isAnimeResultVoiceKey)).toEqual([
      'win-self-draw', 'win-discard', 'win-robbed-kong', 'loss', 'draw',
    ])
    for (const key of ANIME_VOICE_KEYS) {
      expect(Number(isAnimeActionVoiceKey(key)) + Number(isAnimeResultVoiceKey(key))).toBe(1)
      expect(classifyAnimeVoiceKey(key)).toBe(isAnimeActionVoiceKey(key) ? 'action' : 'result')
    }
  })

  it('生成规范化、稳健风格且带版本的固定请求', () => {
    expect(createAnimeFixedTtsRequest('qwen', 'qiangganghu')).toMatchObject({
      schemaVersion: 1,
      cacheVersion: 1,
      characterId: 'qwen',
      animeVoiceKey: 'qiangganghu',
      kind: 'action',
      normalizedText: '抢杠胡,失礼了。',
      voiceKey: 'qwen',
      fallbackVoiceKey: 'default',
      style: '稳健',
    })
    expect(ANIME_FIXED_TTS_SCHEMA_VERSION).toBe(1)
    expect(ANIME_FIXED_TTS_CACHE_VERSION).toBe(1)
  })

  it('未知、非法或缺失角色与 DeepSeek 产生完全相同的请求身份', () => {
    const expected = createAnimeFixedTtsRequest('deepseek', 'hu')
    for (const value of [undefined, null, 'unknown', '../qwen', 'https://example.com/qwen']) {
      expect(createAnimeFixedTtsRequest(value, 'hu')).toEqual(expected)
    }
  })

  it('同一请求获得稳定 cacheIdentity 和 single-flight key', () => {
    const first = createAnimeFixedTtsRequest(' QWEN ', 'win-discard')
    const second = createAnimeFixedTtsRequest('qwen', 'win-discard')
    expect(second).toEqual(first)
    expect(first.singleFlightKey).toBe(`singleflight:${first.cacheIdentity}`)

    const payload = JSON.parse(first.cacheIdentity) as unknown[]
    expect(payload.slice(0, 3)).toEqual([
      'llm-anime-fixed-tts',
      ANIME_FIXED_TTS_SCHEMA_VERSION,
      ANIME_FIXED_TTS_CACHE_VERSION,
    ])
  })

  it('12×11 个固定组合都有唯一、可重复的 cache identity', () => {
    const requests = ANIME_CHARACTERS.flatMap(({ id }) => (
      ANIME_VOICE_KEYS.map((key) => createAnimeFixedTtsRequest(id, key))
    ))
    expect(requests).toHaveLength(132)
    expect(new Set(requests.map(({ cacheIdentity }) => cacheIdentity)).size).toBe(132)
    expect(new Set(requests.map(({ singleFlightKey }) => singleFlightKey)).size).toBe(132)
    for (const request of requests) {
      expect(request.normalizedText).not.toBe('')
      expect(request.style).toBe('稳健')
      expect(request).toEqual(createAnimeFixedTtsRequest(
        request.characterId,
        request.animeVoiceKey,
      ))
    }
  })

  it('identity 对 schema、cache、文案、speaker、音色与风格变化敏感', () => {
    const base: AnimeFixedTtsCacheIdentityParts = {
      schemaVersion: 1,
      cacheVersion: 1,
      characterId: 'deepseek',
      animeVoiceKey: 'chi',
      kind: 'action',
      normalizedText: '吃一口!',
      voiceKey: 'deepseek',
      speaker: 'speaker-a',
      fallbackVoiceKey: 'default',
      fallbackSpeaker: 'speaker-b',
      style: '稳健',
    }
    const baseline = buildAnimeFixedTtsCacheIdentity(base)
    const variations: AnimeFixedTtsCacheIdentityParts[] = [
      { ...base, schemaVersion: 2 },
      { ...base, cacheVersion: 2 },
      { ...base, normalizedText: '再吃一口!' },
      { ...base, speaker: 'speaker-c' },
      { ...base, voiceKey: 'qwen' },
      { ...base, fallbackVoiceKey: 'qwen' },
      { ...base, fallbackSpeaker: 'speaker-c' },
    ]
    for (const variation of variations) {
      expect(buildAnimeFixedTtsCacheIdentity(variation)).not.toBe(baseline)
    }
  })

  it('文本规范化与现有本地 TTS 输入规则一致，且合同层不发网络请求', () => {
    expect(normalizeAnimeFixedTtsText('  \uff21\uff29\t\n  出  牌  ')).toBe('AI 出 牌')
    expect(normalizeAnimeFixedTtsText(`  ${'一'.repeat(40)}  `)).toHaveLength(30)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    createAnimeFixedTtsRequest('muse', 'draw')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
