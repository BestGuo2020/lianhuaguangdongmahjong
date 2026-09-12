// 图片预热：
// 1) `preloadImages` —— 把 URL 拉进浏览器 HTTP 缓存（轻量，不保留引用）；
// 2) `materializeImages` —— 抓成 blob URL 并预热解码，渲染时直接引用（对齐 tileAssets 的存法：
//    同源本地字节、不会再触发校验请求，解码结果已在浏览器图片缓存里）。
//
// 两者语义一致：失败静默，失败项不记入，后续调用仍会重试。

// 本页已成功预取过的 URL：再次调用（主题往返、房间元数据轮询、设置重存）不再创建请求，
// 是否联网完全交给浏览器缓存，本模块不重复发起。失败的不记入，后续调用仍会重试。
const loaded = new Set<string>()

/** 原始 URL → blob URL；存活到页面结束（与 tileAssets 的 objectUrls 同口径）。 */
const materialized = new Map<string, string>()
const materializing = new Map<string, Promise<void>>()

function loadOne(url: string): Promise<boolean> {
  // 非浏览器环境（vitest 的 node 环境、SSR）：没有 Image，视为未加载，不触网。
  if (typeof Image === 'undefined') return Promise.resolve(false)
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
    image.src = url
  })
}

/**
 * 并发预取图片；同一批内的重复 URL 只请求一次，已预取成功的不再请求，
 * 始终 resolve（单张失败不阻塞其他图，且该 URL 之后仍可重试）。
 */
export function preloadImages(urls: Iterable<string | null | undefined>): Promise<void> {
  const fresh = [...new Set(urls)]
    .filter((url): url is string => Boolean(url) && !loaded.has(url))
  return Promise.all(fresh.map(async (url) => {
    if (await loadOne(url)) loaded.add(url)
  })).then(() => {})
}

/** 预热解码：把 blob URL 解一遍，之后新建 <img> 引用同一 blob 时可直接上屏。 */
async function warmDecode(url: string): Promise<void> {
  if (typeof Image === 'undefined') return
  const image = new Image()
  image.src = url
  try {
    if (typeof image.decode === 'function') await image.decode()
    else await new Promise<void>((resolve) => { image.onload = () => resolve(); image.onerror = () => resolve() })
  } catch {
    // 解码失败不阻塞：仍然保留 blob URL（<img> 会自行重试解码）。
  }
}

async function materializeOne(url: string): Promise<void> {
  const response = await fetch(url, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`materialize failed: ${response.status}`)
  const objectUrl = URL.createObjectURL(await response.blob())
  await warmDecode(objectUrl)
  materialized.set(url, objectUrl)
}

/**
 * 把图片物化成 blob URL（同源本地字节，不再随 HTTP 缓存新鲜度重新校验）并预热解码。
 * 供「出现窗口很短、不能等一次网络往返 / 解码」的渲染点使用（例如 llmAnime 动作立绘）。
 * 失败静默：调用方用 `materializedImageSrc()` 拿不到就回退原始 URL，行为不会变差。
 */
export function materializeImages(urls: Iterable<string | null | undefined>): Promise<void> {
  if (typeof fetch === 'undefined' || typeof URL?.createObjectURL !== 'function') return Promise.resolve()
  const targets = [...new Set(urls)]
    .filter((url): url is string => Boolean(url) && !materialized.has(url) && !materializing.has(url))
  return Promise.all(targets.map((url) => {
    const task = materializeOne(url).catch(() => { /* 失败静默，之后可重试 */ })
    materializing.set(url, task)
    void task.finally(() => materializing.delete(url))
    return task
  })).then(() => {})
}

/** 已物化好的 blob URL；还没就绪返回 null（调用方回退原始 URL）。 */
export function materializedImageSrc(url: string | null | undefined): string | null {
  if (!url) return null
  return materialized.get(url) ?? null
}
