import { TILE_TYPES, isHorseForSeat, type HorseSeat } from './tiles'
import type { GamePlayer, Meld, ScoreDelta, TileType } from '../contracts/types'
import { consumeTile, countTiles, firstRemainingTile, matchingCount } from '../../shared/rules/tileTools'
import type { RuleSet, ScoreHandOptions, ScoreHandResult } from './ruleset'

export { matchingCount }

const STANDARD_TILES = TILE_TYPES.filter((tile) => tile !== 'white' && tile !== 'red')
const WINNING_DRAW_TILES: TileType[] = [...STANDARD_TILES, 'white']
export const BASE_SCORE = 100

export function applyKongScore(players: GamePlayer[], kongPlayerIndex: number, type: 'discard' | 'concealed' | 'added', fromIndex: number | null = null) {
  const payers = type === 'discard'
    ? [fromIndex]
    : players.map((_, index) => index).filter((index) => index !== kongPlayerIndex)
  const payment = type === 'concealed' ? BASE_SCORE * 2 : BASE_SCORE
  const validPayers = payers.filter((payerIndex) => Number.isInteger(payerIndex) && payerIndex !== kongPlayerIndex) as number[]
  validPayers.forEach((payerIndex) => {
    players[payerIndex].score -= payment
    players[kongPlayerIndex].score += payment
  })
  const deltas: ScoreDelta[] = [
    { playerIndex: kongPlayerIndex, amount: payment * validPayers.length },
    ...validPayers.map((playerIndex) => ({ playerIndex, amount: -payment })),
  ]
  return deltas.filter(({ amount }) => amount !== 0)
}

export function applyWinScore(
  players: GamePlayer[],
  winnerIndex: number,
  points: number,
  payerIndex: number | null = null,
  dealerIndex: number | null = null,
) {
  const payers = Number.isInteger(payerIndex)
    ? [payerIndex]
    : players.map((_, index) => index).filter((index) => index !== winnerIndex)
  let totalWon = 0
  payers.forEach((index) => {
    // 庄家胡牌的倍数已计入 points；闲家胡牌时，庄家单独支付双倍。
    const payment = winnerIndex !== dealerIndex && index === dealerIndex ? points * 2 : points
    players[index].score -= payment
    players[winnerIndex].score += payment
    totalWon += payment
  })
  return totalWon
}

function canMakeMelds(counts: Map<TileType, number>, jokers: number, needed: number, memo = new Map<string, boolean>()) {
  const signature = `${needed}|${jokers}|${STANDARD_TILES.map((tile) => counts.get(tile) || 0).join('')}`
  if (memo.has(signature)) return memo.get(signature)

  const tile = firstRemainingTile(counts, STANDARD_TILES)
  if (!tile) {
    const result = jokers === needed * 3
    memo.set(signature, result)
    return result
  }
  if (needed <= 0) return false

  const amount = counts.get(tile) || 0
  const tripletReal = Math.min(3, amount)
  if (3 - tripletReal <= jokers) {
    if (canMakeMelds(consumeTile(counts, tile, tripletReal), jokers - (3 - tripletReal), needed - 1, memo)) {
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
        if ((next.get(item) || 0) > 0) next = consumeTile(next, item, 1)
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
  const counts = countTiles(naturals)

  if (jokers >= 2 && canMakeMelds(counts, jokers - 2, neededMelds)) return true

  for (const tile of STANDARD_TILES) {
    const amount = counts.get(tile) || 0
    if (amount >= 2 && canMakeMelds(consumeTile(counts, tile, 2), jokers, neededMelds)) return true
    if (amount >= 1 && jokers >= 1 && canMakeMelds(consumeTile(counts, tile, 1), jokers - 1, neededMelds)) return true
  }
  return false
}

export function waitingTiles(tiles: TileType[], exposedMeldCount = 0) {
  return WINNING_DRAW_TILES.filter((tile) => isWinningHand([...tiles, tile], exposedMeldCount))
}

export function concealedKongs(tiles: TileType[]) {
  return TILE_TYPES.filter((tile) => tile !== 'red' && tile !== 'white' && matchingCount(tiles, tile) === 4)
}

export function canRobKong(tiles: TileType[], kongTile: TileType, exposedMeldCount = 0) {
  return isWinningHand([...tiles, kongTile], exposedMeldCount)
}

export function meldSourceTileIndex(meld: Meld, playerIndex: number) {
  if (!['peng', 'gang', 'chi'].includes(meld.type)) return -1

  // 吃牌的横置牌就是对方实际打出的那一张；来源座位只用于确定
  // 横置方向，不能用来推算顺子中应横置左、中、右哪一张。
  if (meld.type === 'chi') return meld.tiles.indexOf(meld.tile)

  if (!Number.isInteger(meld.from)) return -1
  const relativeSource = (meld.from - playerIndex + 4) % 4
  if (relativeSource === 1) return 0
  if (relativeSource === 2) return Math.min(1, meld.tiles.length - 1)
  if (relativeSource === 3) return meld.tiles.length - 1
  return -1
}

/**
 * 副露的桌面展示顺序。
 * 国标/日麻的吃牌只允许取上家弃牌，因此把吃来的牌横置在该副露左侧，
 * 再把手里的两张牌排在右侧；本项目副露轨道从玩家右手端向手牌方向排布，
 * 所以渲染数组中“左侧”对应最后一项。由于渲染数组会被从右向左落位，
 * 两张手牌也必须反向排列，才能在桌面上保持原本的牌面顺序。
 * meld.tiles 仍保留牌面组成顺序，便于规则计算。
 */
export function meldDisplayTiles(meld: Meld): TileType[] {
  const tiles = meld.added ? meld.tiles.slice(0, 3) : meld.tiles
  if (meld.type !== 'chi') return tiles
  const sourceIndex = tiles.indexOf(meld.tile)
  if (sourceIndex < 0) return tiles
  const companions = [...tiles.slice(0, sourceIndex), ...tiles.slice(sourceIndex + 1)].reverse()
  return [...companions, meld.tile]
}

export function drawHorses(wall: TileType[], amount = 8, seat: HorseSeat = 0) {
  // 广东麻将买马：胡牌后从牌头摸马（连取接下来要摸的牌），中马按胡牌者座位判定。
  const count = Math.min(amount, wall.length)
  const horses = wall.splice(0, count)
  return { horses, hits: horses.filter((tile) => isHorseForSeat(tile, seat)).length }
}

export function scoreHand({ dealer = false, noJoker = false, fourRed = false, kongBloom = false, horseHits = 0, robbedKong = false }: ScoreHandOptions): ScoreHandResult {
  const details: Array<{ label: string; multiplier?: number; points?: number }> = [
    { label: robbedKong ? '抢杠胡' : '自摸', multiplier: 1 },
  ]
  let multiplier = 1
  if (dealer) { multiplier *= 2; details.push({ label: '庄家', multiplier: 2 }) }
  if (noJoker) { multiplier *= 2; details.push({ label: '无癞子', multiplier: 2 }) }
  if (fourRed) { multiplier *= 4; details.push({ label: '四红中', multiplier: 4 }) }
  if (kongBloom) { multiplier *= 2; details.push({ label: '杠上开花', multiplier: 2 }) }
  const horsePoints = horseHits * BASE_SCORE
  const totalMultiplier = multiplier + horseHits
  if (horseHits > 0) {
    details.push({ label: `中马 ${horseHits} 张`, points: horsePoints })
  }
  // 中马始终按张数加底分：底分 × 已知倍数 + 中马数 × 底分。
  const points = multiplier * BASE_SCORE + horsePoints
  return { multiplier, totalMultiplier, horsePoints, points, details }
}

/**
 * The default Guangma ruleset. Keep the standalone exports above for callers
 * that predate ruleset injection; both paths execute the same implementation.
 */
export const CLASSIC_RULESET: RuleSet = {
  id: 'lotus-classic',
  baseScore: BASE_SCORE,
  flow: {
    mode: 'single-win',
    continueAfterWin: false,
    allowMultipleWinners: false,
  },
  win: {
    isWinningHand,
    waitingTiles,
    canRobKong,
    concealedKongs,
  },
  score: {
    scoreHand,
    applyKongScore,
    applyWinScore,
  },
  extension: {
    patternProviders: [],
    settlementHooks: [],
  },
}

export const DEFAULT_RULESET = CLASSIC_RULESET
