import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 模块记录「已预取成功的 URL」，因此每个用例都用 vi.resetModules + 动态导入拿全新实例。
const requested: string[] = []

class MockImage {
  static failUrls = new Set<string>()
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  private value = ''

  set src(value: string) {
    this.value = value
    requested.push(value)
    queueMicrotask(() => (MockImage.failUrls.has(value) ? this.onerror : this.onload)?.())
  }

  get src() { return this.value }
}

function loadModule() {
  return import('./imagePreload')
}

describe('图片预热', () => {
  beforeEach(() => {
    vi.resetModules()
    requested.length = 0
    MockImage.failUrls = new Set()
    vi.stubGlobal('Image', MockImage)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('逐张请求并等待全部完成', async () => {
    const { preloadImages } = await loadModule()

    await preloadImages(['/a.png', '/b.png'])

    expect(requested).toEqual(['/a.png', '/b.png'])
  })

  it('同一批里的重复 URL 与空值只请求一次/被忽略', async () => {
    const { preloadImages } = await loadModule()

    await preloadImages(['/a.png', '/a.png', null, undefined, ''])

    expect(requested).toEqual(['/a.png'])
  })

  it('已预取成功的 URL 再次调用不再发起请求', async () => {
    const { preloadImages } = await loadModule()

    await preloadImages(['/a.png'])
    expect(requested).toEqual(['/a.png'])

    // 主题往返 / 房间元数据轮询 / 设置重存都会重复调用，不应该再创建请求。
    await preloadImages(['/a.png'])
    await preloadImages(['/a.png', '/b.png'])

    expect(requested).toEqual(['/a.png', '/b.png'])
  })

  it('单张加载失败不阻塞其他图，且失败项之后会重试', async () => {
    const { preloadImages } = await loadModule()
    MockImage.failUrls = new Set(['/broken.png'])

    await expect(preloadImages(['/broken.png', '/ok.png'])).resolves.toBeUndefined()

    // 失败与成功都不会 reject；失败的没被记入已预取，成功的被记入。
    expect(requested).toEqual(['/broken.png', '/ok.png'])

    MockImage.failUrls = new Set()
    requested.length = 0
    await preloadImages(['/broken.png', '/ok.png'])

    expect(requested).toEqual(['/broken.png'])   // 只重试失败那张
  })

  it('非浏览器环境（无 Image）不触网也不抛错', async () => {
    const { preloadImages } = await loadModule()
    vi.stubGlobal('Image', undefined)

    await expect(preloadImages(['/a.png'])).resolves.toBeUndefined()

    expect(requested).toEqual([])
  })
})
