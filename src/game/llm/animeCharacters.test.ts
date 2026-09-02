import { describe, expect, it } from 'vitest'
import { LLM_TTS_VOICE_OPTIONS } from './config'
import {
  ANIME_ACTION_VOICE_KEYS,
  ANIME_CHARACTERS,
  ANIME_CHARACTER_IDS,
  ANIME_RESULT_VOICE_KEYS,
  ANIME_TTS_SPEAKERS,
  ANIME_TTS_VOICE_KEYS,
  ANIME_VOICE_KEYS,
  DEFAULT_ANIME_CHARACTER_ID,
  animeVoiceLine,
  isCharacterId,
  resolveAnimeCharacter,
  resolveAnimeCharacterForProvider,
  resolveAnimeCharacterId,
  resolveAnimeCharacterIdForProvider,
} from './animeCharacters'

const codePointLength = (value: string): number => [...value].length

describe('llmAnime character contract', () => {
  it('冻结 12 个角色 ID、中文展示名和 DeepSeek 默认角色', () => {
    expect(ANIME_CHARACTER_IDS).toEqual([
      'claude', 'deepseek', 'doubao', 'gemini', 'glm', 'gpt',
      'grok', 'kimi', 'minimax', 'mistral', 'muse', 'qwen',
    ])
    expect(DEFAULT_ANIME_CHARACTER_ID).toBe('deepseek')
    expect(ANIME_CHARACTERS.map(({ id, label }) => [id, label])).toEqual([
      ['claude', '克劳德书姬'],
      ['deepseek', '大肥鱼'],
      ['doubao', '豆包学妹'],
      ['gemini', '美国豆包'],
      ['glm', '智谱狐姬'],
      ['gpt', 'GPT龙姬'],
      ['grok', 'Grok小恶魔'],
      ['kimi', 'Kimi月姬'],
      ['minimax', 'MiniMax导演'],
      ['mistral', '米斯特拉风狐'],
      ['muse', '缪斯梦姬'],
      ['qwen', '千问大小姐'],
    ])
    expect(new Set(ANIME_CHARACTER_IDS).size).toBe(12)
  })

  it('每个角色完整定义 11 个固定文案，动作和结果均满足长度合同', () => {
    expect(ANIME_VOICE_KEYS).toHaveLength(11)
    expect(ANIME_ACTION_VOICE_KEYS).toHaveLength(6)
    expect(ANIME_RESULT_VOICE_KEYS).toHaveLength(5)

    for (const character of ANIME_CHARACTERS) {
      expect(Object.keys(character.lines).sort()).toEqual([...ANIME_VOICE_KEYS].sort())
      expect(character.ttsStyle).toBe('稳健')
      for (const key of ANIME_ACTION_VOICE_KEYS) {
        expect(codePointLength(character.lines[key]), `${character.id}.${key}`).toBeGreaterThanOrEqual(1)
        expect(codePointLength(character.lines[key]), `${character.id}.${key}`).toBeLessThanOrEqual(8)
      }
      for (const key of ANIME_RESULT_VOICE_KEYS) {
        expect(codePointLength(character.lines[key]), `${character.id}.${key}`).toBeGreaterThanOrEqual(1)
        expect(codePointLength(character.lines[key]), `${character.id}.${key}`).toBeLessThanOrEqual(24)
      }
    }
    expect(ANIME_CHARACTERS.reduce(
      (total, character) => total + Object.keys(character.lines).length,
      0,
    )).toBe(132)
  })

  it('只使用现有 TTS 白名单，并冻结无原生 voice 角色的替代音色', () => {
    const configured = LLM_TTS_VOICE_OPTIONS
      .map(({ value }) => value)
      .filter((value) => value !== 'auto')
    expect(ANIME_TTS_VOICE_KEYS).toEqual(configured)
    for (const character of ANIME_CHARACTERS) {
      expect(ANIME_TTS_VOICE_KEYS).toContain(character.voiceKey)
      expect(ANIME_TTS_VOICE_KEYS).toContain(character.fallbackVoiceKey)
      expect(character.speaker).toBe(ANIME_TTS_SPEAKERS[character.voiceKey])
      expect(character.speaker).toMatch(/^[A-Za-z0-9_.-]+$/)
    }
    expect(ANIME_CHARACTERS.map(({ id, voiceKey, fallbackVoiceKey }) => (
      [id, voiceKey, fallbackVoiceKey]
    ))).toEqual([
      ['claude', 'claude', 'default'],
      ['deepseek', 'deepseek', 'default'],
      ['doubao', 'doubao', 'default'],
      ['gemini', 'qwen', 'default'],
      ['glm', 'glm', 'default'],
      ['gpt', 'gpt', 'relay_gpt'],
      ['grok', 'kimi', 'default'],
      ['kimi', 'kimi', 'default'],
      ['minimax', 'minimax', 'default'],
      ['mistral', 'minimax', 'default'],
      ['muse', 'claude', 'default'],
      ['qwen', 'qwen', 'default'],
    ])
  })

  it('角色解析只接受白名单并对缺失、未知和恶意输入回退 DeepSeek', () => {
    expect(isCharacterId('qwen')).toBe(true)
    expect(isCharacterId('QWEN')).toBe(false)
    expect(resolveAnimeCharacterId(' QWEN ')).toBe('qwen')
    expect(resolveAnimeCharacterId('\uff47\uff50\uff54')).toBe('gpt')

    const invalidValues: unknown[] = [
      undefined, null, 1, {}, '', 'custom', '../qwen', 'qwen/../../evil',
      'https://example.com/qwen', 'qwen<script>', 'a'.repeat(65),
    ]
    for (const value of invalidValues) {
      expect(resolveAnimeCharacterId(value)).toBe('deepseek')
      expect(resolveAnimeCharacter(value).id).toBe('deepseek')
    }
  })

  it('provider 仅做规范化后的精确 alias 映射，未知值回退 DeepSeek', () => {
    const aliases = ANIME_CHARACTERS.flatMap(({ id, providerAliases }) => (
      providerAliases.map((alias) => [alias, id] as const)
    ))
    expect(new Set(aliases.map(([alias]) => alias)).size).toBe(aliases.length)
    for (const [provider, character] of aliases) {
      expect(provider).toMatch(/^[a-z0-9._-]{1,64}$/)
      expect(resolveAnimeCharacterIdForProvider(` ${provider.toUpperCase()} `)).toBe(character)
      expect(resolveAnimeCharacterForProvider(provider).id).toBe(character)
    }

    expect(resolveAnimeCharacterIdForProvider('my-openai-proxy')).toBe('deepseek')
    expect(resolveAnimeCharacterIdForProvider('https://api.openai.com/v1')).toBe('deepseek')
    expect(resolveAnimeCharacterIdForProvider('__proto__')).toBe('deepseek')
    expect(resolveAnimeCharacterIdForProvider(null)).toBe('deepseek')
  })

  it('按角色读取固定文案时对未知角色使用 DeepSeek 文案', () => {
    expect(animeVoiceLine('qwen', 'hu')).toBe('胡了，请承让。')
    expect(animeVoiceLine('../../qwen', 'hu')).toBe('胡啦！')
  })
})
