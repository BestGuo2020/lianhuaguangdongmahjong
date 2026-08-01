import { TILE_TYPES, isHorse } from './tiles'

const STANDARD_TILES = TILE_TYPES.filter((tile) => tile !== 'white' && tile !== 'red')
const WINNING_DRAW_TILES = [...STANDARD_TILES, 'white']

function countsFor(tiles) {
  const counts = new Map()
  tiles.forEach((tile) => counts.set(tile, (counts.get(tile) || 0) + 1))
  return counts
}

function firstRemaining(counts) {
  return STANDARD_TILES.find((tile) => (counts.get(tile) || 0) > 0)
}

function consume(counts, tile, amount) {
  const next = new Map(counts)
  const left = (next.get(tile) || 0) - amount
  if (left > 0) next.set(tile, left)
  else next.delete(tile)
  return next
}

function canMakeMelds(counts, jokers, needed, memo = new Map()) {
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
      const sequence = Array.from({ length: 3 }, (_, index) => `${match[1]}${start + index}`)
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

export function isWinningHand(tiles, exposedMeldCount = 0) {
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

export function waitingTiles(tiles, exposedMeldCount = 0) {
  return WINNING_DRAW_TILES.filter((tile) => isWinningHand([...tiles, tile], exposedMeldCount))
}

export function matchingCount(tiles, tile) {
  return tiles.filter((item) => item === tile).length
}

export function concealedKongs(tiles) {
  return TILE_TYPES.filter((tile) => tile !== 'red' && tile !== 'white' && matchingCount(tiles, tile) === 4)
}

export function canRobKong(tiles, kongTile, exposedMeldCount = 0) {
  return isWinningHand([...tiles, kongTile], exposedMeldCount)
}

export function meldSourceTileIndex(meld, playerIndex) {
  if (!['peng', 'gang'].includes(meld.type) || !Number.isInteger(meld.from)) return -1
  const relativeSource = (meld.from - playerIndex + 4) % 4
  if (relativeSource === 1) return 0
  if (relativeSource === 2) return Math.min(1, meld.tiles.length - 1)
  if (relativeSource === 3) return meld.tiles.length - 1
  return -1
}

export function drawHorses(wall, amount = 8) {
  const horses = wall.splice(0, Math.min(amount, wall.length))
  return { horses, hits: horses.filter(isHorse).length }
}

export function scoreHand({ dealer = false, noJoker = false, fourRed = false, horseHits = 0, robbedKong = false }) {
  const details = [{ label: robbedKong ? '抢杠胡' : '自摸', multiplier: 1 }]
  let multiplier = 1
  if (dealer) { multiplier *= 2; details.push({ label: '庄家', multiplier: 2 }) }
  if (noJoker) { multiplier *= 2; details.push({ label: '无癞子', multiplier: 2 }) }
  if (fourRed) { multiplier *= 4; details.push({ label: '四红中', multiplier: 4 }) }
  const horsePoints = horseHits * 10
  if (horseHits > 0) {
    details.push({ label: `中马 ${horseHits} 张`, points: horsePoints })
  }
  return { multiplier, horsePoints, points: multiplier * 10 + horsePoints, details }
}
