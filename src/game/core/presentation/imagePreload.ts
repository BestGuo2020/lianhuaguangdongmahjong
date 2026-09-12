// 图片预热：把 URL 拉进浏览器缓存，避免首次出现时闪烁/延迟。
// 与 tileAssets / llmAnimeAssets 的预取语义一致：失败静默（首次使用时仍会按需加载）。

// 本页已成功预取过的 URL：再次调用（主题往返、房间元数据轮询、设置重存）不再创建请求，
// 是否联网完全交给浏览器缓存，本模块不重复发起。失败的不记入，后续调用仍会重试。
const loaded = new Set<string>()

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
