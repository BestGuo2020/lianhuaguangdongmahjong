import { describe, expect, it } from 'vitest'
import {
  resolveAnimeAudioPlayerKind,
  resolveAnimeAudioPolicy,
  shouldSuppressLegacyAnimeSpeech,
  type AnimeAudioPlayerKind,
} from './animeAudioPolicy'

describe('llmAnime 声音策略', () => {
  it.each([
    ['human', 'suppress', 'suppress'],
    ['bot', 'play', 'suppress'],
    ['llm', 'suppress', 'play'],
    ['unknown', 'suppress', 'suppress'],
  ] as const)('%s 出牌选择正确的人声路径', (playerKind, tileName, commentary) => {
    const policy = resolveAnimeAudioPolicy({ themeName: 'llmAnime', playerKind })

    expect(policy).toMatchObject({
      theme: 'llmAnime',
      playerKind,
      discard: { playEffect: true, tileName, commentary },
      actionVoice: 'fixed-line',
      resultVoice: 'fixed-line',
    })
  })

  it.each(['human', 'llm', 'bot', 'unknown'] as const)(
    '%s 的动作和结果都使用固定台词人声',
    (playerKind) => {
      const policy = resolveAnimeAudioPolicy({ themeName: 'llmAnime', playerKind })
      expect(policy.actionVoice).toBe('fixed-line')
      expect(policy.resultVoice).toBe('fixed-line')
    },
  )

  it.each([undefined, null, 'llm', 'jade', 'majsoul', 'happyMahjong', 'rosewood'])(
    '非 llmAnime 主题 %s 完整保留 legacy 路由',
    (themeName) => {
      expect(resolveAnimeAudioPolicy({ themeName, playerKind: 'human' })).toEqual({
        theme: 'legacy',
        playerKind: 'human',
        discard: { playEffect: true, tileName: 'legacy', commentary: 'legacy' },
        actionVoice: 'legacy',
        resultVoice: 'legacy',
      })
    },
  )

  it('显式 playerKind 优先于旧 isLlm 标记', () => {
    expect(resolveAnimeAudioPlayerKind({ playerKind: 'human', isLlm: true })).toBe('human')
    expect(resolveAnimeAudioPlayerKind({ playerKind: 'bot', isLlm: true })).toBe('bot')
    expect(resolveAnimeAudioPlayerKind({ playerKind: 'llm', isLlm: false })).toBe('llm')
  })

  it('旧 isLlm 只确认 true，false 或缺失均安全回退 unknown', () => {
    expect(resolveAnimeAudioPlayerKind({ isLlm: true })).toBe('llm')
    expect(resolveAnimeAudioPlayerKind({ isLlm: false })).toBe('unknown')
    expect(resolveAnimeAudioPlayerKind({})).toBe('unknown')
    expect(resolveAnimeAudioPlayerKind({ playerKind: null, isLlm: false })).toBe('unknown')
  })

  it.each([
    ['human', true],
    ['llm', false],
    ['bot', false],
    ['unknown', false],
  ] as Array<[AnimeAudioPlayerKind, boolean]>)('只有 %s 会被当作真人', (playerKind, human) => {
    const resolved = resolveAnimeAudioPolicy({ themeName: 'llmAnime', playerKind })
    expect(resolved.playerKind === 'human').toBe(human)
  })

  it.each(['action', 'round-reaction'])(
    '二次元主题过滤明确标记为 %s 的模型自由语音',
    (purpose) => {
      expect(shouldSuppressLegacyAnimeSpeech('llmAnime', {
        purpose,
        speechSource: 'model-message',
      })).toBe(true)
    },
  )

  it('普通吐槽、fixed-line、旧协议和其他主题不被过滤', () => {
    expect(shouldSuppressLegacyAnimeSpeech('llmAnime', {
      purpose: 'commentary', speechSource: 'model-message',
    })).toBe(false)
    expect(shouldSuppressLegacyAnimeSpeech('llmAnime', {
      purpose: 'action', speechSource: 'fixed-line',
    })).toBe(false)
    expect(shouldSuppressLegacyAnimeSpeech('llmAnime', {})).toBe(false)
    expect(shouldSuppressLegacyAnimeSpeech('llm', {
      purpose: 'action', speechSource: 'model-message',
    })).toBe(false)
  })
})
