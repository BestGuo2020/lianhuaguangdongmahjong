import { describe, expect, it } from 'vitest'
import { ANIME_CHARACTER_IDS } from '../../llm/animeCharacters'
import { ANIME_CHARACTER_ACCENTS, animeCharacterAccent } from './animeCharacterPalette'

describe('llmAnime 角色强调色', () => {
  it('覆盖全部角色并为未知值回退 DeepSeek', () => {
    expect(Object.keys(ANIME_CHARACTER_ACCENTS)).toEqual([...ANIME_CHARACTER_IDS])
    expect(animeCharacterAccent('qwen')).toBe(ANIME_CHARACTER_ACCENTS.qwen)
    expect(animeCharacterAccent('custom-provider')).toBe(ANIME_CHARACTER_ACCENTS.deepseek)
  })
})
