import { describe, expect, it } from 'vitest'
import {
  ANIME_CHARACTER_STORAGE_KEY,
  animeCharacterAvatarUrl,
  readAnimeCharacterPreference,
  saveAnimeCharacterPreference,
} from './animeCharacterPreference'

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial != null) values.set(ANIME_CHARACTER_STORAGE_KEY, initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('llmAnime 本家角色偏好', () => {
  it('缺失或非法存储值回退 DeepSeek', () => {
    expect(readAnimeCharacterPreference(memoryStorage())).toBe('deepseek')
    expect(readAnimeCharacterPreference(memoryStorage('../qwen'))).toBe('deepseek')
  })

  it('保存规范化后的白名单 ID', () => {
    const storage = memoryStorage()
    expect(saveAnimeCharacterPreference(' QWEN ', storage)).toBe('qwen')
    expect(readAnimeCharacterPreference(storage)).toBe('qwen')
  })

  it('Mistral 缺现有头像时回退 DeepSeek 头像', () => {
    expect(animeCharacterAvatarUrl('qwen')).toContain('/img/llm/qwen/')
    expect(animeCharacterAvatarUrl('mistral')).toContain('/img/llm/deepseek/')
  })
})
