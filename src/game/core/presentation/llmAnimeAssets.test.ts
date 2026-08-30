import { describe, expect, it } from 'vitest'
import {
  LLM_ANIME_ASSET_VERSION,
  SHIPPED_ANIME_ACTIONS,
  animeActionArtUrl,
} from './llmAnimeAssets'

describe('llmAnime 运行时资源 manifest', () => {
  it('固定首版资源版本', () => {
    expect(LLM_ANIME_ASSET_VERSION).toBe('v1')
  })

  it('只登记已验收的 DeepSeek 专用 Q 版动作图', () => {
    expect(SHIPPED_ANIME_ACTIONS).toEqual({
      deepseek: ['chi', 'peng', 'gang', 'hu', 'zimo', 'qiangganghu'],
    })
    expect(animeActionArtUrl('deepseek', 'chi')).toMatch(/deepseek\/actions\/chi\.jpg$/)
    expect(animeActionArtUrl('deepseek', 'peng')).toMatch(/deepseek\/actions\/peng\.jpg$/)
    expect(animeActionArtUrl('deepseek', 'gang')).toMatch(/deepseek\/actions\/gang\.jpg$/)
    expect(animeActionArtUrl('deepseek', 'hu')).toMatch(/deepseek\/actions\/hu\.jpg$/)
    expect(animeActionArtUrl('deepseek', 'zimo')).toMatch(/deepseek\/actions\/zimo\.jpg$/)
    expect(animeActionArtUrl('deepseek', 'qiangganghu')).toMatch(/deepseek\/actions\/qiangganghu\.jpg$/)
    expect(animeActionArtUrl('qwen', 'chi')).toBeNull()
  })
})
