import { TILE_TYPES, tileFaceFile } from './tiles'
import type { TileType } from './types'

// 牌面资产预加载：应用启动即把全部牌面拉进内存（blob URL + 已解码位图各存一份），
// 2D（CSS background）与 3D（图集）共用同一份，避免各路径重复请求 / 重复解码。
// 单张失败不阻断：使用方回退网络地址或无图案底色。

const TILE_IMAGES = new Map<TileType, HTMLImageElement>()  // 3D 图集绘制用（已解码）
const TILE_URLS = new Map<TileType, string>()              // 2D CSS background 用（内存 blob URL）
const objectUrls = new Set<string>()                       // 存活到页面结束，不 revoke
let ready: Promise<void> | null = null

function tileNetworkUrl(tile: TileType): string | null {
  const file = tileFaceFile(tile)
  return file ? `${import.meta.env.BASE_URL}tiles/${file}` : null
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = src
  })
}

/** 启动预加载全部牌面。并发只跑一次，之后调用直接复用同一 Promise。 */
export function preloadTileImages(): Promise<void> {
  if (ready) return ready
  ready = Promise.allSettled(TILE_TYPES.map(async (tile) => {
    const url = tileNetworkUrl(tile)
    if (!url) return
    try {
      const response = await fetch(url, { cache: 'force-cache' })
      if (!response.ok) throw new Error(`tile fetch failed: ${url}`)
      const objectUrl = URL.createObjectURL(await response.blob())
      objectUrls.add(objectUrl)
      TILE_URLS.set(tile, objectUrl)
      TILE_IMAGES.set(tile, await decodeImage(objectUrl))
    } catch {
      // 单张牌面加载失败不阻断整个牌桌，牌面回退为无图案底色。
    }
  })).then(() => {})
  return ready
}

/** 已解码牌面表（可能含未加载成功的，调用方自行兜底）。3D 图集用。 */
export function preloadedTileImages(): Map<TileType, HTMLImageElement> {
  return TILE_IMAGES
}

/** 2D 牌面 background 用：优先返回内存 blob URL，未就绪时回退网络地址。 */
export function tileFaceUrl(tile: TileType): string {
  return TILE_URLS.get(tile) ?? tileNetworkUrl(tile) ?? ''
}
