import { TILE_TYPES, isHorse } from './tiles'

const STANDARD_TILES = TILE_TYPES.filter((tile) => tile !== 'white' && tile !== 'red')

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
  if (match && Number(match[2]) <= 7) {
    const sequence = [tile, `${match[1]}${Number(match[2]) + 1}`, `${match[1]}${Number(match[2]) + 2}`]
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

export function matchingCount(tiles, tile) {
  return tiles.filter((item) => item === tile).length
}

export function concealedKongs(tiles) {
  return TILE_TYPES.filter((tile) => tile !== 'red' && matchingCount(tiles, tile) === 4)
}

export function canRobKong(tiles, kongTile, exposedMeldCount = 0) {
  return isWinningHand([...tiles, kongTile], exposedMeldCount)
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
  if (horseHits > 0) {
    const horseMultiplier = 2 ** horseHits
    multiplier *= horseMultiplier
    details.push({ label: `中马 ${horseHits} 张`, multiplier: horseMultiplier })
  }
  return { multiplier, points: multiplier * 10, details }
}
