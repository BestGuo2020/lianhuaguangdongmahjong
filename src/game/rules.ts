import { TILE_TYPES, isHorse } from './tiles'
import type { GamePlayer, Meld, TileType } from './types'

const STANDARD_TILES = TILE_TYPES.filter((tile) => tile !== 'white' && tile !== 'red')
const WINNING_DRAW_TILES: TileType[] = [...STANDARD_TILES, 'white']
export const BASE_SCORE = 100

export function applyKongScore(players: GamePlayer[], kongPlayerIndex: number, type: 'discard' | 'concealed' | 'added', fromIndex: number | null = null) {
  const payers = type === 'discard'
    ? [fromIndex]
    : players.map((_, index) => index).filter((index) => index !== kongPlayerIndex)
  const payment = type === 'concealed' ? BASE_SCORE * 2 : BASE_SCORE
  payers.forEach((payerIndex) => {
    if (!Number.isInteger(payerIndex) || payerIndex === kongPlayerIndex) return
    players[payerIndex].score -= payment
    players[kongPlayerIndex].score += payment
  })
}

export function applyWinScore(players: GamePlayer[], winnerIndex: number, points: number, payerIndex: number | null = null) {
  const payers = Number.isInteger(payerIndex)
    ? [payerIndex]
    : players.map((_, index) => index).filter((index) => index !== winnerIndex)
  payers.forEach((index) => {
    players[index].score -= points
    players[winnerIndex].score += points
  })
  return points * payers.length
}

function countsFor(tiles: TileType[]) {
  const counts = new Map<TileType, number>()
  tiles.forEach((tile) => counts.set(tile, (counts.get(tile) || 0) + 1))
  return counts
}

function firstRemaining(counts: Map<TileType, number>) {
  return STANDARD_TILES.find((tile) => (counts.get(tile) || 0) > 0)
}

function consume(counts: Map<TileType, number>, tile: TileType, amount: number) {
  const next = new Map(counts)
  const left = (next.get(tile) || 0) - amount
  if (left > 0) next.set(tile, left)
  else next.delete(tile)
  return next
}

function canMakeMelds(counts: Map<TileType, number>, jokers: number, needed: number, memo = new Map<string, boolean>()) {
  const signature = `${needed}|${jokers}|${STANDARD_TILES.map((tile) => counts.get(tile) || 0).join('')}`
  if (memo.has(signature)) return memo.get(signature)

  const tile = firstRemaining(counts)
  if (!tile) {
    const result = jokers === needed * 3
    memo.set(signature, result)
    return result
  }
  if (needed <= 0) return false

  const amount = counts.get(tile) || 0
  const tripletReal = Math.min(3, amount)
  if (3 - tripletReal <= jokers) {
    if (canMakeMelds(consume(counts, tile, tripletReal), jokers - (3 - tripletReal), needed - 1, memo)) {
      memo.set(signature, true)
      return true
    }
  }

  const match = /^([mps])([1-9])$/.exec(tile)
  if (match) {
    const rank = Number(match[2])
    const firstRank = Math.max(1, rank - 2)
    const lastRank = Math.min(7, rank)
    for (let start = firstRank; start <= lastRank; start += 1) {
      const sequence = Array.from({ length: 3 }, (_, index) => `${match[1]}${start + index}` as TileType)
      let missing = 0
      let next = new Map(counts)
      sequence.forEach((item) => {
        if ((next.get(item) || 0) > 0) next = consume(next, item, 1)
        else missing += 1
      })
      if (missing <= jokers && canMakeMelds(next, jokers - missing, needed - 1, memo)) {
        memo.set(signature, true)
        return true
      }
    }
  }

  memo.set(signature, false)
  return false
}

export function isWinningHand(tiles: TileType[], exposedMeldCount = 0) {
  const redFiltered = tiles.filter((tile) => tile !== 'red')
  const neededMelds = 4 - exposedMeldCount
  if (redFiltered.length !== neededMelds * 3 + 2) return false

  const jokers = redFiltered.filter((tile) => tile === 'white').length
  const naturals = redFiltered.filter((tile) => tile !== 'white')
  const counts = countsFor(naturals)

  if (jokers >= 2 && canMakeMelds(counts, jokers - 2, neededMelds)) return true

  for (const tile of STANDARD_TILES) {
    const amount = counts.get(tile) || 0
    if (amount >= 2 && canMakeMelds(consume(counts, tile, 2), jokers, neededMelds)) return true
    if (amount >= 1 && jokers >= 1 && canMakeMelds(consume(counts, tile, 1), jokers - 1, neededMelds)) return true
  }
  return false
}

export function waitingTiles(tiles: TileType[], exposedMeldCount = 0) {
  return WINNING_DRAW_TILES.filter((tile) => isWinningHand([...tiles, tile], exposedMeldCount))
}

export function matchingCount(tiles: TileType[], tile: TileType) {
  return tiles.filter((item) => item === tile).length
}

export function concealedKongs(tiles: TileType[]) {
  return TILE_TYPES.filter((tile) => tile !== 'red' && tile !== 'white' && matchingCount(tiles, tile) === 4)
}

export function canRobKong(tiles: TileType[], kongTile: TileType, exposedMeldCount = 0) {
  return isWinningHand([...tiles, kongTile], exposedMeldCount)
}

export function meldSourceTileIndex(meld: Meld, playerIndex: number) {
  if (!['peng', 'gang'].includes(meld.type) || !Number.isInteger(meld.from)) return -1
  const relativeSource = (meld.from - playerIndex + 4) % 4
  if (relativeSource === 1) return 0
  if (relativeSource === 2) return Math.min(1, meld.tiles.length - 1)
  if (relativeSource === 3) return meld.tiles.length - 1
  return -1
}

export function drawHorses(wall: TileType[], amount = 8) {
  const horses = wall.splice(0, Math.min(amount, wall.length))
  return { horses, hits: horses.filter(isHorse).length }
}

export function scoreHand({ dealer = false, noJoker = false, fourRed = false, horseHits = 0, robbedKong = false }) {
  const details: Array<{ label: string; multiplier?: number; points?: number }> = [
    { label: robbedKong ? '抢杠胡' : '自摸', multiplier: 1 },
  ]
  let multiplier = 1
  if (dealer) { multiplier *= 2; details.push({ label: '庄家', multiplier: 2 }) }
  if (noJoker) { multiplier *= 2; details.push({ label: '无癞子', multiplier: 2 }) }
  if (fourRed) { multiplier *= 4; details.push({ label: '四红中', multiplier: 4 }) }
  const horsePoints = horseHits * BASE_SCORE
  if (horseHits > 0) {
    details.push({ label: `中马 ${horseHits} 张`, points: horsePoints })
  }
  return { multiplier, horsePoints, points: multiplier * BASE_SCORE + horsePoints, details }
}
