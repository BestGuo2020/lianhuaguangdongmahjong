import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LLM_ANIME_ASSET_VERSION,
  SHIPPED_ANIME_ACTION_CARD_CHARACTERS,
  animeActionCardKind,
  animeActionArtUrl,
} from './llmAnimeAssets'
import { ANIME_CHARACTER_IDS } from '../../llm/animeCharacters'
import { animeCharacterAvatarUrl } from '../../llm/animeCharacterPreference'

const requested: string[] = []

class MockImage {
  static fail = false
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  private value = ''

  set src(value: string) {
    this.value = value
    requested.push(value)
    queueMicrotask(() => (MockImage.fail ? this.onerror : this.onload)?.())
  }

  get src() { return this.value }
}

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

describe('llmAnime 立绘与头像预取', () => {
  // 12 个角色的鸣牌/胡牌卡共 24 张；头像按角色目录取，mistral 复用 deepseek → 唯一 URL 11 张。
  const uniqueUrls = ANIME_CHARACTER_IDS.length * 2
    + new Set(ANIME_CHARACTER_IDS.map(animeCharacterAvatarUrl)).size

  beforeEach(() => {
    vi.resetModules()
    requested.length = 0
    MockImage.fail = false
    vi.stubGlobal('Image', MockImage)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('预取全部角色头像与每角色两张立绘（鸣牌卡/胡牌卡）', async () => {
    const { preloadAnimeCharacterAssets } = await import('./llmAnimeAssets')
    await preloadAnimeCharacterAssets()

    for (const id of ANIME_CHARACTER_IDS) {
      expect(requested).toContain(animeCharacterAvatarUrl(id))
      expect(requested).toContain(animeActionArtUrl(id, 'peng'))
      expect(requested).toContain(animeActionArtUrl(id, 'hu'))
    }
    // 唯一 URL 各请求一次：同一张卡不得因多个动作类型重复请求，头像复用目录也不重复请求。
    expect(requested).toHaveLength(uniqueUrls)
    expect(new Set(requested).size).toBe(uniqueUrls)
  })

  it('重复与并发调用复用同一预取，不重复拉取', async () => {
    const { preloadAnimeCharacterAssets } = await import('./llmAnimeAssets')
    const first = preloadAnimeCharacterAssets()
    const second = preloadAnimeCharacterAssets()
    expect(second).toBe(first)

    await first
    const afterFirst = requested.length
    // 再次调用（同一 Promise）：不该产生新的图片请求
    await preloadAnimeCharacterAssets()
    expect(requested.length).toBe(afterFirst)
  })

  it('单张图失败不阻塞预取（首次使用时仍按需加载）', async () => {
    MockImage.fail = true
    const { preloadAnimeCharacterAssets } = await import('./llmAnimeAssets')
    await expect(preloadAnimeCharacterAssets()).resolves.toBeUndefined()
    expect(requested).toHaveLength(uniqueUrls)
  })

  it('头像与立绘都物化成 blob URL（渲染点直接引用本地字节）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['card']), { status: 200 })))
    const NativeURL = globalThis.URL
    const objectUrls: string[] = []
    let seq = 0
    class MockURL extends NativeURL {
      static createObjectURL = () => {
        const url = `blob:card/${(seq += 1)}`
        objectUrls.push(url)
        return url
      }
    }
    vi.stubGlobal('URL', MockURL)

    const { preloadAnimeCharacterAssets } = await import('./llmAnimeAssets')
    const { materializedImageSrc } = await import('./imagePreload')
    await preloadAnimeCharacterAssets()

    // 24 张立绘 + 11 张唯一头像全部物化
    expect(objectUrls).toHaveLength(ANIME_CHARACTER_IDS.length * 2
      + new Set(ANIME_CHARACTER_IDS.map(animeCharacterAvatarUrl)).size)
    for (const id of ANIME_CHARACTER_IDS) {
      expect(materializedImageSrc(animeActionArtUrl(id, 'peng'))).toMatch(/^blob:card\//)
      expect(materializedImageSrc(animeActionArtUrl(id, 'hu'))).toMatch(/^blob:card\//)
      expect(materializedImageSrc(animeCharacterAvatarUrl(id))).toMatch(/^blob:card\//)
    }
    // 物化成功的不再走 img 预取兜底：所有 Image 请求都是 blob（预热解码），没有原始路径
    expect(requested.filter((url) => !url.startsWith('blob:'))).toEqual([])
    expect(requested).toHaveLength(objectUrls.length)
  })
})
