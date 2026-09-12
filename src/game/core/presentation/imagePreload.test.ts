import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 模块记录「已预取成功的 URL」，因此每个用例都用 vi.resetModules + 动态导入拿全新实例。
const requested: string[] = []

class MockImage {
  static failUrls = new Set<string>()
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  private value = ''
  decodeCalls = 0

  set src(value: string) {
    this.value = value
    requested.push(value)
    queueMicrotask(() => (MockImage.failUrls.has(value) ? this.onerror : this.onload)?.())
  }

  get src() { return this.value }

  decode() {
    this.decodeCalls += 1
    return MockImage.failUrls.has(this.value) ? Promise.reject(new Error('decode failed')) : Promise.resolve()
  }
}

const NativeURL = globalThis.URL
let objectUrlSeq = 0
const createObjectURL = vi.fn(() => `blob:mock/${(objectUrlSeq += 1)}`)

function stubObjectUrl() {
  objectUrlSeq = 0
  createObjectURL.mockClear()
  class MockURL extends NativeURL {
    static createObjectURL = createObjectURL
  }
  vi.stubGlobal('URL', MockURL)
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
    stubObjectUrl()
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

describe('图片物化（blob URL + 预热解码）', () => {
  beforeEach(() => {
    vi.resetModules()
    requested.length = 0
    MockImage.failUrls = new Set()
    vi.stubGlobal('Image', MockImage)
    stubObjectUrl()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image']), { status: 200 })))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('抓成 blob URL 并预热解码，渲染方可以按原始 URL 取到它', async () => {
    const { materializeImages, materializedImageSrc } = await loadModule()

    expect(materializedImageSrc('/a.jpg')).toBeNull()
    await materializeImages(['/a.jpg', '/a.jpg', '/b.jpg'])

    expect(fetch).toHaveBeenCalledTimes(2)     // 同批重复 URL 只抓一次
    expect(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toBe('/a.jpg')
    expect(materializedImageSrc('/a.jpg')).toBe('blob:mock/1')
    expect(materializedImageSrc('/b.jpg')).toBe('blob:mock/2')
    // blob URL 被解码预热过（解码失败也不影响引用）
    expect(requested).toContain('blob:mock/1')
  })

  it('已物化的 URL 再次调用不再抓取', async () => {
    const { materializeImages } = await loadModule()

    await materializeImages(['/a.jpg'])
    await materializeImages(['/a.jpg'])

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('抓取失败静默且之后可重试', async () => {
    const { materializeImages, materializedImageSrc } = await loadModule()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))

    await expect(materializeImages(['/a.jpg'])).resolves.toBeUndefined()
    expect(materializedImageSrc('/a.jpg')).toBeNull()

    await materializeImages(['/a.jpg'])
    // 重试成功：拿到 blob URL（首次失败没走到 createObjectURL，因此仍是第 1 个）
    expect(materializedImageSrc('/a.jpg')).toBe('blob:mock/1')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('环境不支持 blob URL 时直接返回，不抛错', async () => {
    const { materializeImages, materializedImageSrc } = await loadModule()
    vi.stubGlobal('URL', { createObjectURL: undefined })

    await expect(materializeImages(['/a.jpg'])).resolves.toBeUndefined()

    expect(fetch).not.toHaveBeenCalled()
    expect(materializedImageSrc('/a.jpg')).toBeNull()
  })
})
