import { describe, expect, it } from 'vitest'
import {
  LLM_ANIME_ASSET_VERSION,
  SHIPPED_ANIME_ACTION_CARD_CHARACTERS,
  animeActionCardKind,
  animeActionArtUrl,
} from './llmAnimeAssets'
import { ANIME_CHARACTER_IDS } from '../../llm/animeCharacters'

describe('llmAnime 运行时资源 manifest', () => {
  it('固定首版资源版本', () => {
    expect(LLM_ANIME_ASSET_VERSION).toBe('v1')
  })

  it('每个角色只登记通用鸣牌卡与胡牌卡', () => {
    expect(SHIPPED_ANIME_ACTION_CARD_CHARACTERS).toEqual(ANIME_CHARACTER_IDS)
    expect((['chi', 'peng', 'gang'] as const).map(animeActionCardKind)).toEqual(['call', 'call', 'call'])
    expect((['hu', 'zimo', 'qiangganghu'] as const).map(animeActionCardKind)).toEqual(['win', 'win', 'win'])
    expect(animeActionArtUrl('deepseek', 'chi')).toMatch(/deepseek\/actions\/call\.jpg$/)
    expect(animeActionArtUrl('deepseek', 'peng')).toMatch(/deepseek\/actions\/call\.jpg$/)
    expect(animeActionArtUrl('deepseek', 'gang')).toMatch(/deepseek\/actions\/call\.jpg$/)
    expect(animeActionArtUrl('deepseek', 'hu')).toMatch(/deepseek\/actions\/win\.jpg$/)
    expect(animeActionArtUrl('deepseek', 'zimo')).toMatch(/deepseek\/actions\/win\.jpg$/)
    expect(animeActionArtUrl('deepseek', 'qiangganghu')).toMatch(/deepseek\/actions\/win\.jpg$/)
    expect(animeActionArtUrl('qwen', 'chi')).toMatch(/qwen\/actions\/call\.jpg$/)
    expect(animeActionArtUrl('custom-provider', 'hu')).toMatch(/deepseek\/actions\/win\.jpg$/)
  })
})
