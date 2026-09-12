// 图片预热：把 URL 拉进浏览器缓存，避免首次出现时闪烁/延迟。
// 与 tileAssets / llmAnimeAssets 的预取语义一致：失败静默（首次使用时仍会按需加载）。

function loadOne(url: string): Promise<void> {
  // 非浏览器环境（vitest 的 node 环境、SSR）：没有 Image，直接视为完成，不触网。
  if (typeof Image === 'undefined') return Promise.resolve()
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve()
    image.onerror = () => resolve()
    image.src = url
  })
}

/**
 * 并发预取图片；同一批内的重复 URL 只请求一次，始终 resolve（单张失败不阻塞其他图）。
 * 重复调用同一 URL 由浏览器 HTTP 缓存兜底，调用方不需要自己记账。
 */
export function preloadImages(urls: Iterable<string | null | undefined>): Promise<void> {
  const unique = [...new Set(urls)].filter((url): url is string => Boolean(url))
  return Promise.all(unique.map(loadOne)).then(() => {})
}
