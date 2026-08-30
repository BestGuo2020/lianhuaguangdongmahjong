import { TILE_TYPES, tileFaceFile } from '../rules/tiles'
import type { TileType } from '../contracts/types'

// 牌面资产预加载：把全部牌面拉进内存（blob URL + 已解码图片各存一份），
// 2D（CSS background）与 3D（图集）共用同一份，避免各路径重复请求 / 重复解码。

export type TileAssetTheme = 'jade' | 'llmAnime' | (string & {})

export interface TileAssetManifest {
  /** 34 张牌面候选地址，第一项为主题资源，第二项为稳定的默认资源。 */
  faces: Readonly<Record<TileType, readonly [string, string]>>
  /** 牌背图片候选地址；3D 尚未使用位图时仍可由调用方读取此合同。 */
  back: readonly [string, string]
}

const TILE_CACHE = new Map<TileAssetTheme, Map<TileType, HTMLImageElement>>()
const TILE_URL_CACHE = new Map<TileAssetTheme, Map<TileType, string>>()
const READY_CACHE = new Map<TileAssetTheme, Promise<void>>()
const objectUrls = new Set<string>()                       // 存活到页面结束，不 revoke
let activeTheme: TileAssetTheme = 'jade'
const MAX_LOAD_ATTEMPTS = 3
const FETCH_TIMEOUT_MS = 12_000
const DECODE_TIMEOUT_MS = 12_000
const RETRY_DELAY_MS = 150

function legacyTileUrl(tile: TileType): string | null {
  const file = tileFaceFile(tile)
  return file ? `${import.meta.env.BASE_URL}tiles/${file}` : null
}

function themeTileUrl(theme: TileAssetTheme, tile: TileType): string | null {
  const file = tileFaceFile(tile)
  if (!file) return null
  return theme === 'llmAnime'
    ? `${import.meta.env.BASE_URL}themes/llm-anime/v1/tiles/${file}`
    : legacyTileUrl(tile)
}

/** 明确列出主题资源和回退资源，避免 2D/3D 各自拼接路径导致缓存串图。 */
export function tileAssetManifest(theme: TileAssetTheme = activeTheme): TileAssetManifest {
  const faces = Object.fromEntries(TILE_TYPES.map((tile) => [
    tile,
    [themeTileUrl(theme, tile) ?? '', legacyTileUrl(tile) ?? ''] as const,
  ])) as Record<TileType, readonly [string, string]>
  const themedBack = theme === 'llmAnime'
    ? `${import.meta.env.BASE_URL}themes/llm-anime/v1/tile-back.png`
    : `${import.meta.env.BASE_URL}tiles/tile-back.png`
  return { faces, back: [themedBack, `${import.meta.env.BASE_URL}tiles/tile-back.png`] }
}

function cachesFor(theme: TileAssetTheme) {
  if (!TILE_CACHE.has(theme)) TILE_CACHE.set(theme, new Map())
  if (!TILE_URL_CACHE.has(theme)) TILE_URL_CACHE.set(theme, new Map())
  return { images: TILE_CACHE.get(theme)!, urls: TILE_URL_CACHE.get(theme)! }
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

async function loadTile(theme: TileAssetTheme, tile: TileType): Promise<void> {
  const { images, urls } = cachesFor(theme)
  if (urls.has(tile) && images.has(tile)) return
  const candidates = tileAssetManifest(theme).faces[tile].filter(Boolean)
  if (!candidates.length) throw new Error(`missing tile asset path: ${tile}`)

  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
    let objectUrl: string | null = null
    try {
      const blob = await fetchTile(candidates[attempt === 1 ? 0 : 1] ?? candidates[0])
      objectUrl = URL.createObjectURL(blob)
      const image = await decodeImage(objectUrl)
      objectUrls.add(objectUrl)
      urls.set(tile, objectUrl)
      images.set(tile, image)
      return
    } catch (error) {
      lastError = error
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      if (attempt < MAX_LOAD_ATTEMPTS) await wait(RETRY_DELAY_MS * attempt)
    }
  }
  throw new Error(`tile asset failed after ${MAX_LOAD_ATTEMPTS} attempts: ${candidates[0]}`, { cause: lastError })
}

/**
 * 预加载并解码全部牌面。并发调用复用同一 Promise；任何一张失败都会拒绝，
 * 且清除共享 Promise，让下一次调用只重试尚未成功的牌面。
 */
export function preloadTileImages(theme: TileAssetTheme = activeTheme): Promise<void> {
  activeTheme = theme
  const existing = READY_CACHE.get(theme)
  if (existing) return existing
  const loading = Promise.allSettled(TILE_TYPES.map((tile) => loadTile(theme, tile))).then((results) => {
    const failed = results
      .map((result, index) => result.status === 'rejected' ? TILE_TYPES[index] : null)
      .filter((tile): tile is TileType => tile !== null)
    if (failed.length) throw new Error(`牌面资源加载失败：${failed.join('、')}`)
  })
  const ready = loading.catch((error) => {
    READY_CACHE.delete(theme)
    throw error
  })
  READY_CACHE.set(theme, ready)
  return ready
}

/** 已成功解码的牌面表。3D 牌桌只会在完整预加载成功后读取。 */
export function preloadedTileImages(theme: TileAssetTheme = activeTheme): Map<TileType, HTMLImageElement> {
  return cachesFor(theme).images
}

/** 2D 牌面 background 用：优先返回内存 blob URL，未就绪时回退网络地址。 */
export function tileFaceUrl(tile: TileType, theme: TileAssetTheme = activeTheme): string {
  return cachesFor(theme).urls.get(tile) ?? tileAssetManifest(theme).faces[tile]?.[0] ?? ''
}

/** 牌背候选地址（图片缺失时由 3D 主题渐变或 CSS 回退兜底）。 */
export function tileBackUrl(theme: TileAssetTheme = activeTheme): string {
  return tileAssetManifest(theme).back[0]
}
