import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TILE_TYPES } from '../rules/tiles'

const NativeURL = globalThis.URL

class MockImage {
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  private value = ''

  set src(value: string) {
    this.value = value
    if (value) queueMicrotask(() => this.onload?.())
  }

  get src() { return this.value }
  decode() { return Promise.resolve() }
}

describe('tile asset preload', () => {
  const createObjectURL = vi.fn(() => `blob:tile-${createObjectURL.mock.calls.length}`)
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    vi.stubGlobal('Image', MockImage)
    class MockURL extends NativeURL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    }
    vi.stubGlobal('URL', MockURL)
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('retries a transient failure and resolves only after every tile is decoded', async () => {
    let m1Attempts = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/tiles/1m.png') && ++m1Attempts < 3) {
        return new Response('', { status: 503 })
      }
      return new Response(new Blob(['tile']), { status: 200 })
    }))

    const { preloadTileImages, preloadedTileImages } = await import('./tileAssets')
    await preloadTileImages()

    expect(m1Attempts).toBe(3)
    expect(preloadedTileImages().size).toBe(TILE_TYPES.length)
  })

  it('rejects an incomplete preload and lets a later call retry only missing tiles', async () => {
    let failM1 = true
    let m1Attempts = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/tiles/1m.png')) {
        m1Attempts += 1
        if (failM1) return new Response('', { status: 503 })
      }
      return new Response(new Blob(['tile']), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { preloadTileImages, preloadedTileImages } = await import('./tileAssets')
    await expect(preloadTileImages()).rejects.toThrow('牌面资源加载失败：m1')
    expect(preloadedTileImages().size).toBe(TILE_TYPES.length - 1)

    failM1 = false
    await preloadTileImages()

    expect(m1Attempts).toBe(4)
    expect(fetchMock).toHaveBeenCalledTimes(TILE_TYPES.length + 3)
    expect(preloadedTileImages().size).toBe(TILE_TYPES.length)
  })

  it('publishes an explicit llmAnime manifest with a per-tile default fallback', async () => {
    const { tileAssetManifest, tileBackUrl } = await import('./tileAssets')
    const manifest = tileAssetManifest('llmAnime')
    expect(Object.keys(manifest.faces)).toHaveLength(TILE_TYPES.length)
    expect(manifest.faces.m1).toEqual(['/themes/llm-anime/v1/tiles/1m.png', '/tiles/1m.png'])
    expect(manifest.faces.white).toEqual(['/themes/llm-anime/v1/tiles/7z.png', '/tiles/7z.png'])
    expect(manifest.back).toEqual(['/themes/llm-anime/v1/tile-back.png', '/tiles/tile-back.png'])
    expect(tileBackUrl('llmAnime')).toBe('/themes/llm-anime/v1/tile-back.png')
  })

  it('keeps llmAnime and legacy decoded image caches isolated', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/themes/llm-anime/')) return new Response('', { status: 404 })
      return new Response(new Blob(['tile']), { status: 200 })
    }))
    const { preloadTileImages, preloadedTileImages } = await import('./tileAssets')
    await preloadTileImages('llmAnime')
    await preloadTileImages('jade')
    expect(preloadedTileImages('llmAnime')).not.toBe(preloadedTileImages('jade'))
    expect(preloadedTileImages('llmAnime').size).toBe(TILE_TYPES.length)
    expect(preloadedTileImages('jade').size).toBe(TILE_TYPES.length)
  })
})
