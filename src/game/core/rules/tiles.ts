import type { HonorTile, Suit, TileType } from '../contracts/types'

export const SUITS: Suit[] = ['m', 'p', 's']
export const HONORS: HonorTile[] = ['east', 'south', 'west', 'north', 'red', 'green', 'white']

export const TILE_META = {
  back: { name: '牌背', col: 0, row: 0 },
  m1: { name: '一万', col: 1, row: 0 }, p1: { name: '一筒', col: 2, row: 0 }, s1: { name: '一条', col: 3, row: 0 },
  east: { name: '东风', col: 4, row: 0 }, m2: { name: '二万', col: 5, row: 0 }, p2: { name: '二筒', col: 6, row: 0 },
  s2: { name: '二条', col: 0, row: 1 }, south: { name: '南风', col: 1, row: 1 }, m3: { name: '三万', col: 2, row: 1 },
  p3: { name: '三筒', col: 3, row: 1 }, s3: { name: '三条', col: 4, row: 1 }, west: { name: '西风', col: 5, row: 1 }, m4: { name: '四万', col: 6, row: 1 },
  p4: { name: '四筒', col: 0, row: 2 }, s4: { name: '四条', col: 1, row: 2 }, north: { name: '北风', col: 2, row: 2 },
  m5: { name: '五万', col: 3, row: 2 }, p5: { name: '五筒', col: 4, row: 2 }, s5: { name: '五条', col: 5, row: 2 }, white: { name: '白板（癞子）', col: 6, row: 2 },
  m6: { name: '六万', col: 0, row: 3 }, p6: { name: '六筒', col: 1, row: 3 }, s6: { name: '六条', col: 2, row: 3 }, green: { name: '发财', col: 3, row: 3 },
  m7: { name: '七万', col: 4, row: 3 }, p7: { name: '七筒', col: 5, row: 3 }, s7: { name: '七条', col: 6, row: 3 },
  red: { name: '红中', col: 0, row: 4 }, m8: { name: '八万', col: 1, row: 4 }, p8: { name: '八筒', col: 2, row: 4 }, s8: { name: '八条', col: 3, row: 4 },
  m9: { name: '九万', col: 4, row: 4 }, p9: { name: '九筒', col: 5, row: 4 }, s9: { name: '九条', col: 6, row: 4 },
}

export const TILE_TYPES: TileType[] = [
  ...SUITS.flatMap((suit) => Array.from({ length: 9 }, (_, index) => `${suit}${index + 1}`)),
  ...HONORS,
] as TileType[]

const HONOR_FACE_INDEX = { east: 1, south: 2, west: 3, north: 4, red: 5, green: 6, white: 7 }

export function tileFaceFile(tile: TileType) {
  const suited = /^([mps])([1-9])$/.exec(tile)
  if (suited) return `${suited[2]}${suited[1]}.png`
  return HONOR_FACE_INDEX[tile] ? `${HONOR_FACE_INDEX[tile]}z.png` : null
}

/** 出牌报牌的牌名语音文件（如 3m → '3m.mp3'，东风 → '1z.mp3'）。 */
export function tileAudioFile(tile: TileType) {
  const suited = /^([mps])([1-9])$/.exec(tile)
  if (suited) return `${suited[2]}${suited[1]}.mp3`
  return HONOR_FACE_INDEX[tile] ? `${HONOR_FACE_INDEX[tile]}z.mp3` : null
}

export const tileOrder = (tile: TileType) => TILE_TYPES.indexOf(tile)
export const sortTiles = (tiles: TileType[]) => [...tiles].sort((a, b) => tileOrder(a) - tileOrder(b))
/** 莲花麻将手牌排序：精牌保持牌面顺序，但整体固定排在最左侧。 */
export const sortTilesWithJokers = (tiles: TileType[], jokers: TileType[]) => {
  const jokerSet = new Set(jokers)
  return [...tiles].sort((a, b) => {
    const aJoker = jokerSet.has(a) ? 0 : 1
    const bJoker = jokerSet.has(b) ? 0 : 1
    return aJoker - bJoker || tileOrder(a) - tileOrder(b)
  })
}
export const tileName = (tile: TileType) => TILE_META[tile]?.name ?? tile

export function createWall() {
  return TILE_TYPES.flatMap((tile) => Array(4).fill(tile))
}

export function shuffle<T>(items: T[], random = Math.random): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export function isHorse(tile: TileType) {
  return tile === 'red' || /^[mps][159]$/.test(tile)
}
