import { afterEach, describe, expect, it, vi } from 'vitest'
import { preloadImages } from './imagePreload'

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

afterEach(() => {
  vi.unstubAllGlobals()
  MockImage.fail = false
  requested.length = 0
})

describe('图片预热', () => {
  it('逐张请求并等待全部完成', async () => {
    vi.stubGlobal('Image', MockImage)

    await preloadImages(['/a.png', '/b.png'])

    expect(requested).toEqual(['/a.png', '/b.png'])
  })

  it('同一批里的重复 URL 与空值只请求一次/被忽略', async () => {
    vi.stubGlobal('Image', MockImage)

    await preloadImages(['/a.png', '/a.png', null, undefined, ''])

    expect(requested).toEqual(['/a.png'])
  })

  it('单张加载失败不阻塞其他图，且不 reject', async () => {
    vi.stubGlobal('Image', MockImage)
    MockImage.fail = true

    await expect(preloadImages(['/broken.png', '/ok.png'])).resolves.toBeUndefined()

    expect(requested).toEqual(['/broken.png', '/ok.png'])
  })

  it('非浏览器环境（无 Image）不触网也不抛错', async () => {
    vi.stubGlobal('Image', undefined)

    await expect(preloadImages(['/a.png'])).resolves.toBeUndefined()

    expect(requested).toEqual([])
  })
})
