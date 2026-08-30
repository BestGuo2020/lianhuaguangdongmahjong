import { describe, expect, it } from 'vitest'
import {
  LLM_ANIME_ASSET_VERSION,
  SHIPPED_ANIME_PORTRAITS,
  animePortraitUrl,
  resolveShippedAnimePortraitId,
} from './llmAnimeAssets'

describe('llmAnime 运行时资源 manifest', () => {
  it('首批只发布已验证真透明的 DeepSeek 立绘', () => {
    expect(LLM_ANIME_ASSET_VERSION).toBe('v1')
    expect(SHIPPED_ANIME_PORTRAITS).toEqual(['deepseek'])
  })

  it('缺失角色和非法 ID 均回退 DeepSeek 资源', () => {
    expect(resolveShippedAnimePortraitId('qwen')).toBe('deepseek')
    expect(resolveShippedAnimePortraitId('../qwen')).toBe('deepseek')
    expect(animePortraitUrl('qwen')).toMatch(/themes\/llm-anime\/v1\/characters\/deepseek\/portrait\.png$/)
  })
})
