import { TILE_TYPES, tileFaceFile } from '../rules/tiles'
import type { TileType } from '../contracts/types'

// 牌面资产预加载：把全部牌面拉进内存（blob URL + 已解码图片各存一份），
// 2D（CSS background）与 3D（图集）共用同一份，避免各路径重复请求 / 重复解码。

const TILE_IMAGES = new Map<TileType, HTMLImageElement>()  // 3D 图集绘制用（已解码）
const TILE_URLS = new Map<TileType, string>()              // 2D CSS background 用（内存 blob URL）
const objectUrls = new Set<string>()                       // 存活到页面结束，不 revoke
let ready: Promise<void> | null = null
const MAX_LOAD_ATTEMPTS = 3
const FETCH_TIMEOUT_MS = 12_000
const DECODE_TIMEOUT_MS = 12_000
const RETRY_DELAY_MS = 150

function tileNetworkUrl(tile: TileType): string | null {
  const file = tileFaceFile(tile)
  return file ? `${import.meta.env.BASE_URL}tiles/${file}` : null
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false
    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      image.src = ''
      reject(new Error('tile image decode timed out'))
    }, DECODE_TIMEOUT_MS)
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      callback()
    }
    image.onload = () => {
      const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve()
      void decoded.then(
        () => finish(() => resolve(image)),
        (error) => finish(() => reject(error)),
      )
    }
    image.onerror = () => finish(() => reject(new Error('tile image decode failed')))
    image.src = src
  })
}

const wait = (delay: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delay))

async function fetchTile(url: string): Promise<Blob> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { cache: 'force-cache', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.blob()
  } finally {
    window.clearTimeout(timeout)
  }
}

async function loadTile(tile: TileType): Promise<void> {
  if (TILE_URLS.has(tile) && TILE_IMAGES.has(tile)) return
  const url = tileNetworkUrl(tile)
  if (!url) throw new Error(`missing tile asset path: ${tile}`)

  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
    let objectUrl: string | null = null
    try {
      const blob = await fetchTile(url)
      objectUrl = URL.createObjectURL(blob)
      const image = await decodeImage(objectUrl)
      objectUrls.add(objectUrl)
      TILE_URLS.set(tile, objectUrl)
      TILE_IMAGES.set(tile, image)
      return
    } catch (error) {
      lastError = error
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      if (attempt < MAX_LOAD_ATTEMPTS) await wait(RETRY_DELAY_MS * attempt)
    }
  }
  throw new Error(`tile asset failed after ${MAX_LOAD_ATTEMPTS} attempts: ${url}`, { cause: lastError })
}

/**
 * 预加载并解码全部牌面。并发调用复用同一 Promise；任何一张失败都会拒绝，
 * 且清除共享 Promise，让下一次调用只重试尚未成功的牌面。
 */
export function preloadTileImages(): Promise<void> {
  if (ready) return ready
  const loading = Promise.allSettled(TILE_TYPES.map(loadTile)).then((results) => {
    const failed = results
      .map((result, index) => result.status === 'rejected' ? TILE_TYPES[index] : null)
      .filter((tile): tile is TileType => tile !== null)
    if (failed.length) throw new Error(`牌面资源加载失败：${failed.join('、')}`)
  })
  ready = loading.catch((error) => {
    ready = null
    throw error
  })
  return ready
}

/** 已成功解码的牌面表。3D 牌桌只会在完整预加载成功后读取。 */
export function preloadedTileImages(): Map<TileType, HTMLImageElement> {
  return TILE_IMAGES
}

/** 2D 牌面 background 用：优先返回内存 blob URL，未就绪时回退网络地址。 */
export function tileFaceUrl(tile: TileType): string {
  return TILE_URLS.get(tile) ?? tileNetworkUrl(tile) ?? ''
}
